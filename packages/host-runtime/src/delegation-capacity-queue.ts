import path from "node:path";

import {
  DEFAULT_DELEGATION_CAPACITY_SETTINGS,
  delegationCapacitySettingsSchema,
  type DelegationCapacitySettings,
} from "@codexhost/shared-contracts";

import type {
  DelegationQueueStore,
  PersistedQueuedDelegation,
} from "./delegation-capacity-store.js";
import { projectDelegationThreadSnapshot } from "./delegation-snapshot.js";
import {
  DelegationControlError,
  type DelegationAdmission,
  type DelegationAdmissionRequest,
  type DelegationCapacityGate,
  type DelegationStartIdentity,
  type DelegationStartInput,
  type DelegationThreadListItem,
  type DelegationThreadSnapshot,
  type ThreadCancelResult,
  type ThreadReadInput,
} from "./delegation-types.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_SETTINGS_GRACE_MS = 5 * 60_000;
const IMPLICIT_DEDUPLICATION_MS = 30_000;
const MAX_FINISHED_ENTRIES = 50;
const MAX_TIMER_MS = 2_147_483_647;
const CANCELLED_NOTE = "Removed from the queue before it started";
const RESTART_NOTE =
  "The Host Runtime restarted while this queued delegation was starting; start it again if the Thread does not exist";

interface QueueEntry {
  record: PersistedQueuedDelegation;
  state: "queued" | "starting";
  started?: Promise<void>;
}

/** A queued start that never became a Thread: cancelled, failed to start, or cut off by a restart. */
interface FinishedEntry {
  record: PersistedQueuedDelegation;
  status: "failed" | "interrupted";
  message: string;
}

/** What the queue needs from the Host sessions it sits above. */
export interface DelegationCapacityRuntime {
  /** Top-level Threads with an active Turn in any session; Harness subagents excluded. */
  runningThreadIds(): Iterable<string>;
  /** False while no session could take a start. */
  canStart(): boolean;
  start(input: DelegationStartInput, identity: DelegationStartIdentity): Promise<unknown>;
}

function identityOf(record: PersistedQueuedDelegation): DelegationStartIdentity {
  return { delegationId: record.delegationId, threadId: record.threadId, turnId: record.turnId };
}

function inputOf(record: PersistedQueuedDelegation): DelegationStartInput {
  return {
    harnessId: record.harnessId,
    task: record.task,
    ...(record.taskName !== undefined ? { taskName: record.taskName } : {}),
    cwd: record.cwd,
    parentThreadId: record.parentThreadId,
    ...(record.requestId !== undefined ? { requestId: record.requestId } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.thinkingOptionId ? { thinkingOptionId: record.thinkingOptionId } : {}),
  };
}

function recordFor(request: DelegationAdmissionRequest): PersistedQueuedDelegation {
  const { input, identity } = request;
  return {
    ...identity,
    harnessId: input.harnessId,
    task: input.task,
    ...(input.taskName !== undefined ? { taskName: input.taskName } : {}),
    cwd: input.cwd,
    parentThreadId: input.parentThreadId,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    title: request.title,
    taskDigest: request.taskDigest,
    queuedAt: Date.now(),
  };
}

/**
 * Local limit on concurrently running top-level Threads. Only delegated starts
 * wait; a start that finds the limit reached, or anything already waiting, is
 * queued and started in order once a slot frees. The setting lives in memory
 * like idle release; the queue itself is stored and resumes after a restart.
 */
export class DelegationCapacityQueue implements DelegationCapacityGate {
  readonly #runtime: DelegationCapacityRuntime;
  readonly #store: DelegationQueueStore | undefined;
  readonly #diagnose: (error: unknown) => void;
  readonly #pollIntervalMs: number;
  readonly #settingsGraceMs: number;
  readonly #entries: QueueEntry[] = [];
  /** Admitted starts whose Thread may not report as running yet. */
  readonly #reserved = new Set<string>();
  readonly #finished = new Map<string, FinishedEntry>();
  readonly #listeners = new Set<() => void>();
  readonly #ready: Promise<void>;
  /** Unknown after a restart until the Renderer delivers it again. */
  #settings: DelegationCapacitySettings | undefined;
  #writes: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  #graceTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(
    runtime: DelegationCapacityRuntime,
    options: {
      store?: DelegationQueueStore;
      diagnose?: (error: unknown) => void;
      pollIntervalMs?: number;
      settingsGraceMs?: number;
    } = {},
  ) {
    this.#runtime = runtime;
    this.#store = options.store;
    this.#diagnose = options.diagnose ?? (() => undefined);
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#settingsGraceMs = options.settingsGraceMs ?? DEFAULT_SETTINGS_GRACE_MS;
    this.#ready = this.#store ? this.#restore(this.#store) : Promise.resolve();
  }

  configure(value: DelegationCapacitySettings): DelegationCapacitySettings {
    const settings = delegationCapacitySettingsSchema.parse(value);
    this.#settings = settings;
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    this.#graceTimer = undefined;
    this.#pump();
    return { ...settings };
  }

  async admit(request: DelegationAdmissionRequest): Promise<DelegationAdmission> {
    await this.#ready;
    if (this.#closed) throw new DelegationControlError("INTERNAL_ERROR", "Host Runtime is closing");
    const existing = this.#duplicate(request);
    if (existing) return this.#queued(existing);
    if (!this.#mustQueue()) return this.#reserve(request.identity.threadId);
    const entry: QueueEntry = { record: recordFor(request), state: "queued" };
    this.#entries.push(entry);
    await this.#persist();
    this.#schedule();
    return this.#queued(entry);
  }

  /** Re-evaluates the queue, for example after a session registers. */
  refresh(): void {
    this.#pump();
  }

  async peek(
    threadId: string,
  ): Promise<{ status: "queued" | "creating"; position?: number } | undefined> {
    await this.#ready;
    const entry = this.#entry(threadId);
    if (!entry) return undefined;
    const position = this.#position(entry);
    return { status: this.#status(entry), ...(position ? { position } : {}) };
  }

  /** The snapshot of a Thread that is waiting or being started by the queue. */
  async read(input: ThreadReadInput): Promise<DelegationThreadSnapshot | undefined> {
    await this.#ready;
    const entry = this.#entry(input.threadId);
    if (!entry) return undefined;
    const position = this.#position(entry);
    return {
      ...this.#snapshot(entry.record, input, true),
      status: this.#status(entry),
      ...(position ? { queue: { position } } : {}),
    };
  }

  /** The terminal snapshot of a queued start that never became a Thread. */
  async finished(input: ThreadReadInput): Promise<DelegationThreadSnapshot | undefined> {
    await this.#ready;
    const finished = this.#finished.get(input.threadId);
    if (!finished || this.#entry(input.threadId)) return undefined;
    return {
      ...this.#snapshot(finished.record, input, false),
      status: finished.status,
      result: { availability: "unavailable", message: finished.message },
    };
  }

  /** Resolves true once the Thread has left the queue, or false when the timeout passes first. */
  async settled(threadId: string, timeoutMs: number): Promise<boolean> {
    await this.#ready;
    if (!this.#entry(threadId)) return true;
    return new Promise((resolve) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer);
        this.#listeners.delete(check);
        resolve(value);
      };
      const check = (): void => {
        if (!this.#entry(threadId)) finish(true);
      };
      const timer = setTimeout(() => finish(false), Math.min(timeoutMs, MAX_TIMER_MS));
      this.#listeners.add(check);
    });
  }

  /**
   * Removes a waiting start. A start already in progress is awaited instead and
   * left to the session, which owns the Thread from then on.
   */
  async cancel(threadId: string): Promise<ThreadCancelResult | undefined> {
    await this.#ready;
    const entry = this.#entry(threadId);
    if (!entry) return undefined;
    if (entry.state === "starting") {
      await entry.started;
      return undefined;
    }
    this.#remove(entry);
    this.#finish(entry.record, "interrupted", CANCELLED_NOTE);
    await this.#persist();
    this.#schedule();
    return { threadId, turnId: null, harnessId: entry.record.harnessId, cancelled: true };
  }

  /** Waiting and starting Threads for a list by parent, or by workspace when no parent is given. */
  async list(input: {
    parentThreadId?: string;
    cwd?: string;
  }): Promise<DelegationThreadListItem[]> {
    await this.#ready;
    return this.#entries
      .filter(({ record }) =>
        input.parentThreadId
          ? record.parentThreadId === input.parentThreadId
          : input.cwd === undefined || path.resolve(record.cwd) === path.resolve(input.cwd),
      )
      .map((entry) => {
        const position = this.#position(entry);
        const queuedAt = new Date(entry.record.queuedAt).toISOString();
        return {
          threadId: entry.record.threadId,
          harnessId: entry.record.harnessId,
          deepLink: `codex://threads/${entry.record.threadId}`,
          status: this.#status(entry),
          cwd: entry.record.cwd,
          title: entry.record.title,
          createdAt: queuedAt,
          updatedAt: queuedAt,
          ...(position ? { queue: { position } } : {}),
        };
      });
  }

  /** Stops starting work in this process. The stored queue stays on disk for the next Runtime. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    this.#timer = undefined;
    this.#graceTimer = undefined;
  }

  async #restore(store: DelegationQueueStore): Promise<void> {
    let records: PersistedQueuedDelegation[];
    try {
      records = await store.adopt();
    } catch (error) {
      this.#diagnose(error);
      return;
    }
    if (records.length === 0 || this.#closed) return;
    let interrupted = 0;
    for (const record of records) {
      if (record.starting) {
        // The restart ended the Harness process the start was talking to.
        this.#finish(record, "interrupted", RESTART_NOTE);
        interrupted += 1;
      } else {
        this.#entries.push({ record, state: "queued" });
      }
    }
    if (this.#entries.length > 0) {
      this.#diagnose(`restored ${this.#entries.length} queued delegation(s) after a restart`);
    }
    if (interrupted > 0) {
      this.#diagnose(`${interrupted} queued delegation(s) were starting at the restart`);
      void this.#persist();
    }
    if (this.#settings === undefined && this.#entries.length > 0) {
      // The setting arrives from the Renderer; without one, the queue must not wait forever.
      this.#graceTimer = setTimeout(() => {
        this.#graceTimer = undefined;
        if (this.#settings !== undefined) return;
        this.#diagnose("no delegation capacity setting arrived; starting the restored queue");
        this.#settings = { ...DEFAULT_DELEGATION_CAPACITY_SETTINGS };
        this.#pump();
      }, this.#settingsGraceMs);
      this.#graceTimer.unref?.();
    }
    this.#pump();
  }

  #duplicate(request: DelegationAdmissionRequest): QueueEntry | undefined {
    const { input, taskDigest } = request;
    if (input.requestId) {
      const entry = this.#entries.find(({ record }) => record.requestId === input.requestId);
      if (
        entry &&
        (entry.record.harnessId !== input.harnessId || entry.record.taskDigest !== taskDigest)
      ) {
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "Request ID is already associated with another Delegation configuration",
        );
      }
      return entry;
    }
    const since = Date.now() - IMPLICIT_DEDUPLICATION_MS;
    return this.#entries.find(
      ({ record }) =>
        record.parentThreadId === input.parentThreadId &&
        record.harnessId === input.harnessId &&
        record.taskDigest === taskDigest &&
        record.queuedAt >= since,
    );
  }

  #mustQueue(): boolean {
    // Starts never overtake waiting ones, including restored ones waiting for the setting.
    if (this.#entries.some((entry) => entry.state === "queued")) return true;
    const settings = this.#settings;
    return settings?.enabled === true && this.#occupied() >= settings.maxRunning;
  }

  #occupied(): number {
    const threads = new Set(this.#runtime.runningThreadIds());
    for (const threadId of this.#reserved) threads.add(threadId);
    return threads.size;
  }

  #reserve(threadId: string): DelegationAdmission {
    this.#reserved.add(threadId);
    let released = false;
    return {
      state: "admitted",
      release: () => {
        if (released) return;
        released = true;
        this.#reserved.delete(threadId);
        this.#pump();
      },
    };
  }

  #queued(entry: QueueEntry): DelegationAdmission {
    const position = this.#position(entry);
    return {
      state: "queued",
      identity: identityOf(entry.record),
      status: this.#status(entry),
      ...(position ? { position } : {}),
      parentThreadId: entry.record.parentThreadId,
      cwd: entry.record.cwd,
      title: entry.record.title,
    };
  }

  #pump(): void {
    if (this.#closed) return;
    try {
      for (;;) {
        const next = this.#entries.find((entry) => entry.state === "queued");
        const settings = this.#settings;
        if (!next || settings === undefined || !this.#runtime.canStart()) break;
        if (settings.enabled && this.#occupied() >= settings.maxRunning) break;
        this.#launch(next);
      }
    } catch (error) {
      this.#diagnose(error);
    }
    this.#schedule();
  }

  #launch(entry: QueueEntry): void {
    const { record } = entry;
    entry.state = "starting";
    this.#reserved.add(record.threadId);
    void this.#persist();
    this.#notify();
    entry.started = this.#runtime
      .start(inputOf(record), identityOf(record))
      .then(
        () => this.#remove(entry),
        (error: unknown) => {
          this.#remove(entry);
          this.#finish(record, "failed", error instanceof Error ? error.message : String(error));
          this.#diagnose(error);
        },
      )
      .finally(() => {
        this.#reserved.delete(record.threadId);
        void this.#persist();
        this.#pump();
      });
  }

  #schedule(): void {
    const waiting = !this.#closed && this.#entries.some((entry) => entry.state === "queued");
    if (!waiting) {
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = undefined;
      return;
    }
    if (this.#timer) return;
    // Slots free when Turns end in any session; polling the running set keeps one rule for all.
    this.#timer = setInterval(() => this.#pump(), this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  #entry(threadId: string): QueueEntry | undefined {
    return this.#entries.find((entry) => entry.record.threadId === threadId);
  }

  #status(entry: QueueEntry): "queued" | "creating" {
    return entry.state === "queued" ? "queued" : "creating";
  }

  #position(entry: QueueEntry): number | undefined {
    if (entry.state !== "queued") return undefined;
    return this.#entries.filter((candidate) => candidate.state === "queued").indexOf(entry) + 1;
  }

  #snapshot(
    record: PersistedQueuedDelegation,
    input: ThreadReadInput,
    running: boolean,
  ): DelegationThreadSnapshot {
    return projectDelegationThreadSnapshot({
      threadId: record.threadId,
      harnessId: record.harnessId,
      thread: { name: record.title },
      turns: [],
      running,
      view: input.view,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }

  #remove(entry: QueueEntry): void {
    const index = this.#entries.indexOf(entry);
    if (index >= 0) this.#entries.splice(index, 1);
    this.#notify();
  }

  #finish(record: PersistedQueuedDelegation, status: FinishedEntry["status"], message: string) {
    this.#finished.delete(record.threadId);
    this.#finished.set(record.threadId, { record, status, message });
    for (const threadId of [...this.#finished.keys()].slice(0, -MAX_FINISHED_ENTRIES)) {
      this.#finished.delete(threadId);
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #persist(): Promise<void> {
    const store = this.#store;
    if (!store || this.#closed) return Promise.resolve();
    // Each write stores the queue as it is when the write runs, in order.
    const next = this.#writes
      .then(() =>
        store.save(
          this.#entries.map(({ record, state }) =>
            state === "starting" ? { ...record, starting: true } : record,
          ),
        ),
      )
      .catch((error: unknown) => this.#diagnose(error));
    this.#writes = next;
    return next;
  }
}
