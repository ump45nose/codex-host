import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DelegationCapacityQueue,
  type DelegationCapacityRuntime,
} from "../src/delegation-capacity-queue.js";
import type {
  DelegationQueueStore,
  PersistedQueuedDelegation,
} from "../src/delegation-capacity-store.js";
import type {
  DelegationAdmission,
  DelegationAdmissionRequest,
  DelegationStartIdentity,
  DelegationStartInput,
} from "../src/delegation-types.js";

let sequence = 0;

function request(
  patch: Partial<DelegationAdmissionRequest["input"]> = {},
  taskDigest?: string,
): DelegationAdmissionRequest {
  sequence += 1;
  return {
    input: {
      harnessId: "pi",
      task: `task ${sequence}`,
      cwd: "/work",
      parentThreadId: "parent",
      ...patch,
    },
    title: `Task ${sequence}`,
    taskDigest: taskDigest ?? `digest-${sequence}`,
    identity: {
      delegationId: `delegation-${sequence}`,
      threadId: `child-${sequence}`,
      turnId: `turn-${sequence}`,
    },
  };
}

function record(patch: Partial<PersistedQueuedDelegation> = {}): PersistedQueuedDelegation {
  return {
    delegationId: "delegation-stored",
    threadId: "child-stored",
    turnId: "turn-stored",
    harnessId: "pi",
    task: "stored task",
    cwd: "/work",
    parentThreadId: "parent",
    title: "Stored",
    taskDigest: "digest-stored",
    queuedAt: 1,
    ...patch,
  };
}

/** Sessions whose started Threads keep running until a test removes them. */
function sessions() {
  const running = new Set<string>();
  const starts: { input: DelegationStartInput; identity: DelegationStartIdentity }[] = [];
  const hold = { next: false };
  const held = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const runtime: DelegationCapacityRuntime = {
    runningThreadIds: () => running,
    canStart: () => true,
    start: vi.fn(async (input: DelegationStartInput, identity: DelegationStartIdentity) => {
      starts.push({ input, identity });
      if (hold.next) {
        hold.next = false;
        await new Promise<void>((resolve, reject) => {
          held.set(identity.threadId, { resolve, reject });
        });
      }
      running.add(identity.threadId);
    }),
  };
  const started = () => starts.map((start) => start.identity.threadId);
  return { running, starts, hold, held, runtime, started };
}

class MemoryQueueStore implements DelegationQueueStore {
  saved: PersistedQueuedDelegation[] = [];
  saves = 0;
  #adoptable: PersistedQueuedDelegation[];

  constructor(adoptable: PersistedQueuedDelegation[] = []) {
    this.#adoptable = adoptable;
  }

  async adopt() {
    const adopted = this.#adoptable;
    this.#adoptable = [];
    return adopted;
  }

  async save(entries: readonly PersistedQueuedDelegation[]) {
    this.saves += 1;
    this.saved = entries.map((entry) => ({ ...entry }));
  }
}

function queued(admission: DelegationAdmission) {
  if (admission.state !== "queued") throw new Error("expected a queued start");
  return admission;
}

function admitted(admission: DelegationAdmission) {
  if (admission.state !== "admitted") throw new Error("expected an admitted start");
  return admission;
}

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

describe("DelegationCapacityQueue", () => {
  const queues: DelegationCapacityQueue[] = [];
  const track = (queue: DelegationCapacityQueue) => {
    queues.push(queue);
    return queue;
  };
  afterEach(() => {
    for (const queue of queues.splice(0)) queue.close();
    vi.useRealTimers();
  });

  it("admits every start at once while the limit is off or not yet delivered", async () => {
    const value = sessions();
    for (let index = 0; index < 8; index += 1) value.running.add(`manual-${index}`);
    const store = new MemoryQueueStore();
    const queue = track(new DelegationCapacityQueue(value.runtime, { store }));

    const undelivered = admitted(await queue.admit(request()));
    undelivered.release();
    undelivered.release();
    expect(queue.configure({ enabled: false, maxRunning: 1 })).toEqual({
      enabled: false,
      maxRunning: 1,
    });
    const starts = await Promise.all([1, 2, 3].map(() => queue.admit(request())));
    expect(starts.map((start) => start.state)).toEqual(["admitted", "admitted", "admitted"]);
    expect(await queue.list({})).toEqual([]);
    expect(value.runtime.start).not.toHaveBeenCalled();
    expect(store.saves).toBe(0);
  });

  it("rejects invalid settings", () => {
    const queue = track(new DelegationCapacityQueue(sessions().runtime));
    for (const maxRunning of [0, 33, 1.5]) {
      expect(() => queue.configure({ enabled: true, maxRunning })).toThrow();
    }
  });

  it("queues starts beyond the limit in arrival order, counting manual Threads and starts in flight", async () => {
    const value = sessions();
    value.running.add("manual");
    const store = new MemoryQueueStore();
    const queue = track(new DelegationCapacityQueue(value.runtime, { store }));
    queue.configure({ enabled: true, maxRunning: 2 });

    const first = admitted(await queue.admit(request()));
    const secondRequest = request({ taskName: "Second" });
    const second = queued(await queue.admit(secondRequest));
    const thirdRequest = request({ parentThreadId: "other", cwd: "/other" });
    const third = queued(await queue.admit(thirdRequest));
    expect(second).toEqual({
      state: "queued",
      identity: secondRequest.identity,
      status: "queued",
      position: 1,
      parentThreadId: "parent",
      cwd: "/work",
      title: secondRequest.title,
    });
    expect(third).toMatchObject({ identity: thirdRequest.identity, position: 2 });
    expect(store.saved).toEqual([
      expect.objectContaining({ ...secondRequest.identity, taskName: "Second", harnessId: "pi" }),
      expect.objectContaining(thirdRequest.identity),
    ]);

    expect(
      await queue.read({ threadId: thirdRequest.identity.threadId, view: "result" }),
    ).toMatchObject({
      threadId: thirdRequest.identity.threadId,
      harnessId: "pi",
      title: thirdRequest.title,
      status: "queued",
      queue: { position: 2 },
      turn: null,
      result: { availability: "pending" },
    });
    expect(await queue.peek(secondRequest.identity.threadId)).toEqual({
      status: "queued",
      position: 1,
    });
    expect(
      (await queue.list({ parentThreadId: "parent" })).map(({ threadId, status, queue }) => ({
        threadId,
        status,
        queue,
      })),
    ).toEqual([
      { threadId: secondRequest.identity.threadId, status: "queued", queue: { position: 1 } },
    ]);
    expect((await queue.list({ cwd: "/other/." })).map((row) => row.threadId)).toEqual([
      thirdRequest.identity.threadId,
    ]);
    expect(await queue.list({})).toHaveLength(2);

    // A slot that frees while others wait goes to the head of the queue, never to a newcomer.
    first.release();
    await flush();
    expect(value.started()).toEqual([secondRequest.identity.threadId]);
    expect(queued(await queue.admit(request())).position).toBe(2);
  });

  it("starts queued work in order as running Threads finish", async () => {
    vi.useFakeTimers();
    const value = sessions();
    value.running.add("busy");
    const queue = track(new DelegationCapacityQueue(value.runtime, { pollIntervalMs: 1_000 }));
    queue.configure({ enabled: true, maxRunning: 1 });
    const model = harnessModelRefSchema.parse({ id: "model-a" });
    const firstRequest = request({ model, requestId: "first" });
    queued(await queue.admit(firstRequest));
    const secondRequest = request();
    queued(await queue.admit(secondRequest));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(value.runtime.start).not.toHaveBeenCalled();

    value.running.delete("busy");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.starts).toEqual([{ input: firstRequest.input, identity: firstRequest.identity }]);
    expect(
      await queue.read({ threadId: firstRequest.identity.threadId, view: "result" }),
    ).toBeUndefined();
    expect(await queue.peek(secondRequest.identity.threadId)).toEqual({
      status: "queued",
      position: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(value.started()).toEqual([firstRequest.identity.threadId]);
    value.running.delete(firstRequest.identity.threadId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.started()).toEqual([
      firstRequest.identity.threadId,
      secondRequest.identity.threadId,
    ]);
    expect(await queue.list({})).toEqual([]);
  });

  it("starts what fits when the limit is raised, and everything when it is turned off", async () => {
    const value = sessions();
    value.running.add("busy");
    const queue = track(new DelegationCapacityQueue(value.runtime));
    queue.configure({ enabled: true, maxRunning: 1 });
    const waiting: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const next = request();
      queued(await queue.admit(next));
      waiting.push(next.identity.threadId);
    }
    queue.configure({ enabled: true, maxRunning: 3 });
    await flush();
    expect(value.started()).toEqual(waiting.slice(0, 2));
    queue.configure({ enabled: false, maxRunning: 3 });
    await flush();
    expect(value.started()).toEqual(waiting);
  });

  it("reports a queued start that fails to begin as failed", async () => {
    const value = sessions();
    value.running.add("busy");
    const diagnose = vi.fn();
    const store = new MemoryQueueStore();
    const queue = track(new DelegationCapacityQueue(value.runtime, { store, diagnose }));
    queue.configure({ enabled: true, maxRunning: 1 });
    const entry = request();
    queued(await queue.admit(entry));
    value.hold.next = true;
    value.running.delete("busy");
    queue.refresh();
    await flush();
    const read = { threadId: entry.identity.threadId, view: "result" as const };
    expect(await queue.read(read)).toMatchObject({ status: "creating" });
    expect(await queue.peek(entry.identity.threadId)).toEqual({ status: "creating" });
    expect(store.saved).toEqual([expect.objectContaining({ starting: true })]);

    const failure = new Error("Harness is unavailable");
    value.held.get(entry.identity.threadId)?.reject(failure);
    await flush();
    expect(await queue.read(read)).toBeUndefined();
    expect(await queue.finished(read)).toMatchObject({
      status: "failed",
      turn: null,
      result: { availability: "unavailable", message: "Harness is unavailable" },
    });
    expect(diagnose).toHaveBeenCalledWith(failure);
    expect(store.saved).toEqual([]);
  });

  it("restores the stored queue after a restart and resumes it once the limit arrives", async () => {
    const before = sessions();
    before.running.add("busy");
    const store = new MemoryQueueStore();
    const first = track(new DelegationCapacityQueue(before.runtime, { store }));
    first.configure({ enabled: true, maxRunning: 1 });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("high");
    const head = request({ requestId: "retry" }, "digest-retry");
    const tail = request({ thinkingOptionId });
    queued(await first.admit(head));
    queued(await first.admit(tail));
    first.close();

    const after = sessions();
    const diagnose = vi.fn();
    const restoredStore = new MemoryQueueStore(store.saved);
    const restored = track(
      new DelegationCapacityQueue(after.runtime, { store: restoredStore, diagnose }),
    );
    expect(await restored.peek(head.identity.threadId)).toEqual({ status: "queued", position: 1 });
    expect(await restored.read({ threadId: tail.identity.threadId, view: "result" })).toMatchObject(
      {
        status: "queued",
        queue: { position: 2 },
      },
    );
    expect(diagnose).toHaveBeenCalledWith("restored 2 queued delegation(s) after a restart");
    // Until the Renderer delivers the limit again, nothing restored starts and nothing overtakes it.
    const newcomer = request();
    expect(queued(await restored.admit(newcomer)).position).toBe(3);
    // A retried start keeps its Thread across the restart.
    expect(
      queued(await restored.admit(request({ requestId: "retry" }, "digest-retry"))).identity,
    ).toEqual(head.identity);
    await flush();
    expect(after.runtime.start).not.toHaveBeenCalled();

    restored.configure({ enabled: true, maxRunning: 2 });
    await flush();
    expect(after.starts).toEqual([
      { input: head.input, identity: head.identity },
      { input: tail.input, identity: tail.identity },
    ]);
    expect(restoredStore.saved.map((entry) => entry.threadId)).toEqual([
      newcomer.identity.threadId,
    ]);
  });

  it("reports a start cut off by the restart as interrupted instead of starting it twice", async () => {
    const value = sessions();
    const store = new MemoryQueueStore([record({ starting: true })]);
    const queue = track(new DelegationCapacityQueue(value.runtime, { store }));
    queue.configure({ enabled: false, maxRunning: 4 });
    await flush();
    expect(value.runtime.start).not.toHaveBeenCalled();
    const read = { threadId: "child-stored", view: "result" as const };
    expect(await queue.read(read)).toBeUndefined();
    expect(await queue.finished(read)).toMatchObject({
      status: "interrupted",
      title: "Stored",
      result: { availability: "unavailable", message: expect.stringContaining("restarted") },
    });
    expect(store.saves).toBe(1);
    expect(store.saved).toEqual([]);
  });

  it("starts the restored queue as if the limit were off when no setting arrives", async () => {
    vi.useFakeTimers();
    const value = sessions();
    const diagnose = vi.fn();
    const queue = track(
      new DelegationCapacityQueue(value.runtime, {
        store: new MemoryQueueStore([record()]),
        diagnose,
        settingsGraceMs: 60_000,
      }),
    );
    await vi.advanceTimersByTimeAsync(59_000);
    expect(value.runtime.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.started()).toEqual(["child-stored"]);
    expect(diagnose).toHaveBeenCalledWith(
      "no delegation capacity setting arrived; starting the restored queue",
    );
    expect(await queue.list({})).toEqual([]);
  });

  it("removes a waiting start on cancel and reports it interrupted", async () => {
    const value = sessions();
    value.running.add("busy");
    const store = new MemoryQueueStore();
    const queue = track(new DelegationCapacityQueue(value.runtime, { store }));
    queue.configure({ enabled: true, maxRunning: 1 });
    const first = request();
    const second = request();
    queued(await queue.admit(first));
    queued(await queue.admit(second));

    expect(await queue.cancel(first.identity.threadId)).toEqual({
      threadId: first.identity.threadId,
      turnId: null,
      harnessId: "pi",
      cancelled: true,
    });
    expect(await queue.peek(second.identity.threadId)).toEqual({ status: "queued", position: 1 });
    expect(store.saved.map((entry) => entry.threadId)).toEqual([second.identity.threadId]);
    expect(
      await queue.finished({ threadId: first.identity.threadId, view: "result" }),
    ).toMatchObject({
      status: "interrupted",
      result: { availability: "unavailable", message: "Removed from the queue before it started" },
    });
    expect(await queue.cancel(first.identity.threadId)).toBeUndefined();

    value.running.delete("busy");
    queue.refresh();
    await flush();
    expect(value.started()).toEqual([second.identity.threadId]);
  });

  it("leaves a start already under way to its session when cancelled", async () => {
    const value = sessions();
    value.running.add("busy");
    const queue = track(new DelegationCapacityQueue(value.runtime));
    queue.configure({ enabled: true, maxRunning: 1 });
    const entry = request();
    queued(await queue.admit(entry));
    value.hold.next = true;
    value.running.delete("busy");
    queue.refresh();
    await flush();
    let settled = false;
    const cancelling = queue.cancel(entry.identity.threadId).then((result) => {
      settled = true;
      return result;
    });
    await flush();
    expect(settled).toBe(false);
    value.held.get(entry.identity.threadId)?.resolve();
    await expect(cancelling).resolves.toBeUndefined();
    expect(
      await queue.finished({ threadId: entry.identity.threadId, view: "result" }),
    ).toBeUndefined();
  });

  it("returns the waiting entry for a retried start and rejects a conflicting request ID", async () => {
    const value = sessions();
    value.running.add("busy");
    const queue = track(new DelegationCapacityQueue(value.runtime));
    queue.configure({ enabled: true, maxRunning: 1 });
    const original = request({ requestId: "same" }, "digest-a");
    queued(await queue.admit(original));
    expect(queued(await queue.admit(request({ requestId: "same" }, "digest-a"))).identity).toEqual(
      original.identity,
    );
    await expect(queue.admit(request({ requestId: "same" }, "digest-b"))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    const implicit = request({}, "digest-c");
    queued(await queue.admit(implicit));
    expect(queued(await queue.admit(request({}, "digest-c"))).identity).toEqual(implicit.identity);
    expect(queued(await queue.admit(request({}, "digest-d"))).position).toBe(3);
  });

  it("settles a wait when the start leaves the queue, or reports the timeout", async () => {
    const value = sessions();
    value.running.add("busy");
    const queue = track(new DelegationCapacityQueue(value.runtime));
    queue.configure({ enabled: true, maxRunning: 1 });
    const entry = request();
    queued(await queue.admit(entry));
    await expect(queue.settled(entry.identity.threadId, 10)).resolves.toBe(false);
    const settling = queue.settled(entry.identity.threadId, 60_000);
    value.running.delete("busy");
    queue.refresh();
    await expect(settling).resolves.toBe(true);
    await expect(queue.settled("unknown", 10)).resolves.toBe(true);
  });

  it("stops starting work once closed and keeps the stored queue", async () => {
    const value = sessions();
    value.running.add("busy");
    const store = new MemoryQueueStore();
    const queue = new DelegationCapacityQueue(value.runtime, { store });
    queue.configure({ enabled: true, maxRunning: 1 });
    const entry = request();
    queued(await queue.admit(entry));
    queue.close();
    value.running.delete("busy");
    queue.refresh();
    await flush();
    expect(value.runtime.start).not.toHaveBeenCalled();
    expect(store.saved.map((saved) => saved.threadId)).toEqual([entry.identity.threadId]);
    await expect(queue.admit(request())).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
