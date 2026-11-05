import { normalizeDueAt, normalizeOptionalDueAt } from "./dates.js";
import { canonicalThreadId } from "./thread-id.js";

export const SCHEMA_VERSION = 1;

export interface StashPinMemory {
  wasPinned: true;
  index: number | null;
  beforeThreadId: string | null;
}

export interface StashItem {
  title: string;
  dueAt: string | null;
  stashedAt: string;
  pin?: StashPinMemory;
  hostId?: string;
}

export interface StashState {
  version: typeof SCHEMA_VERSION;
  updatedAt: string | null;
  items: Record<string, StashItem>;
}

export function emptyState(): StashState {
  return {
    version: SCHEMA_VERSION,
    updatedAt: null,
    items: Object.create(null) as Record<string, StashItem>,
  };
}

export function parseState(raw: unknown): { state: StashState; dropped: number } {
  const state = emptyState();
  let dropped = 0;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { state, dropped };
  const record = raw as Record<string, unknown>;
  if (record.version !== SCHEMA_VERSION || !record.items || typeof record.items !== "object") {
    return { state, dropped };
  }
  if (typeof record.updatedAt === "string" && !Number.isNaN(Date.parse(record.updatedAt))) {
    state.updatedAt = record.updatedAt;
  }
  for (const [key, value] of Object.entries(record.items as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      dropped += 1;
      continue;
    }
    let threadId: string;
    try {
      threadId = canonicalThreadId(key);
    } catch {
      dropped += 1;
      continue;
    }
    const item = value as Record<string, unknown>;
    if (typeof item.title !== "string") {
      dropped += 1;
      continue;
    }
    let dueAt: string | null;
    let stashedAt: string;
    try {
      dueAt = normalizeOptionalDueAt(item.dueAt);
      stashedAt = normalizeDueAt(item.stashedAt);
    } catch {
      dropped += 1;
      continue;
    }
    state.items[threadId] = {
      title: item.title,
      dueAt,
      stashedAt,
      ...parsePin(item.pin),
      ...parseHost(item.hostId),
    };
  }
  return { state, dropped };
}

export function stateTime(state: unknown): number {
  if (!state || typeof state !== "object") return 0;
  const updatedAt = (state as { updatedAt?: unknown }).updatedAt;
  const time = typeof updatedAt === "string" ? Date.parse(updatedAt) : NaN;
  return Number.isFinite(time) ? time : 0;
}

export function chooseNewer(left: StashState, right: StashState): StashState {
  return stateTime(right) > stateTime(left) ? right : left;
}

export function parsePin(raw: unknown): { pin?: StashPinMemory } {
  if (!raw || typeof raw !== "object" || (raw as { wasPinned?: unknown }).wasPinned !== true) {
    return {};
  }
  const value = raw as { index?: unknown; beforeThreadId?: unknown };
  const index =
    Number.isInteger(value.index) && (value.index as number) >= 0 ? (value.index as number) : null;
  let beforeThreadId: string | null = null;
  if (typeof value.beforeThreadId === "string") {
    try {
      beforeThreadId = canonicalThreadId(value.beforeThreadId);
    } catch {
      beforeThreadId = null;
    }
  }
  return { pin: { wasPinned: true, index, beforeThreadId } };
}

export function parseHost(raw: unknown): { hostId?: string } {
  if (typeof raw !== "string") return {};
  const value = raw.trim();
  if (!value || value.length > 200 || !/^[A-Za-z0-9:._~@\/-]+$/.test(value)) return {};
  return { hostId: value };
}
