import { normalizeOptionalDueAt } from "./dates.js";
import {
  emptyState,
  parseHost,
  parsePin,
  type StashItem,
  type StashPinMemory,
  type StashState,
} from "./state.js";
import { canonicalThreadId } from "./thread-id.js";

export type StashListener = (state: StashState) => void;

export interface StashPutInput {
  threadId: unknown;
  title?: unknown;
  dueAt?: unknown;
  pin?: unknown;
  hostId?: unknown;
  stashedAt?: unknown;
}

export class StashStore {
  private state: StashState;
  private readonly listeners = new Set<StashListener>();
  private clock: () => Date;

  constructor(initial: StashState | null | undefined, options: { clock?: () => Date } = {}) {
    this.state = initial ? structuredClone(initial) : emptyState();
    this.clock = options.clock ?? (() => new Date());
  }

  getState(): StashState {
    return this.state;
  }

  replace(next: StashState): void {
    this.state = structuredClone(next);
    this.emit();
  }

  subscribe(listener: StashListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  put(input: StashPutInput): StashItem {
    const threadId = canonicalThreadId(input.threadId);
    const previous = this.state.items[threadId];
    const next: StashItem = {
      title: normalizeTitle(input.title, previous?.title),
      dueAt:
        "dueAt" in (input as object)
          ? normalizeOptionalDueAt(input.dueAt)
          : (previous?.dueAt ?? null),
      stashedAt: previous?.stashedAt ?? normalizeStashedAt(input.stashedAt, this.clock()),
    };
    const pin = "pin" in (input as object) ? parsePin(input.pin).pin : previous?.pin;
    if (pin) next.pin = pin;
    const hostId =
      "hostId" in (input as object) ? parseHost(input.hostId).hostId : previous?.hostId;
    if (hostId) next.hostId = hostId;
    this.state.items[threadId] = next;
    this.touch();
    this.emit();
    return next;
  }

  remove(threadIdInput: unknown): boolean {
    const threadId = canonicalThreadId(threadIdInput);
    if (!(threadId in this.state.items)) return false;
    const { [threadId]: _removed, ...rest } = this.state.items;
    void _removed;
    this.state.items = rest;
    this.touch();
    this.emit();
    return true;
  }

  has(threadIdInput: unknown): boolean {
    try {
      return canonicalThreadId(threadIdInput) in this.state.items;
    } catch {
      return false;
    }
  }

  get(threadIdInput: unknown): StashItem | null {
    try {
      return this.state.items[canonicalThreadId(threadIdInput)] ?? null;
    } catch {
      return null;
    }
  }

  private touch(): void {
    this.state.updatedAt = this.clock().toISOString();
  }

  private emit(): void {
    const snapshot = this.state;
    for (const listener of this.listeners) listener(snapshot);
  }
}

function normalizeTitle(value: unknown, fallback?: string): string {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  if (typeof fallback === "string" && fallback.trim()) return fallback.trim().slice(0, 200);
  return "Untitled";
}

function normalizeStashedAt(value: unknown, now: Date): string {
  if (value === undefined || value === null || value === "") return now.toISOString();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("invalid stashedAt");
    return value.toISOString();
  }
  if (typeof value !== "string") throw new TypeError("invalid stashedAt");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError("invalid stashedAt");
  return parsed.toISOString();
}

export type { StashPinMemory };
