import type { JsonValue } from "@codexhost/protocol-core";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Live Harness events only: retains ancestry, never event or conversation content. */
export class ThreadActivity {
  readonly #parents = new Map<string, string>();
  readonly #listeners = new Set<(threadIds: readonly string[]) => void>();

  subscribe(listener: (threadIds: readonly string[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  note(threadId: string, parentThreadId?: string): void {
    if (parentThreadId && parentThreadId !== threadId) this.#parents.set(threadId, parentThreadId);
    const active = new Set<string>();
    let current: string | undefined = threadId;
    while (current && !active.has(current)) {
      active.add(current);
      current = this.#parents.get(current);
    }
    const threadIds = [...active];
    for (const listener of this.#listeners) listener(threadIds);
  }

  observeOfficial(value: JsonValue): void {
    // Replies to Host polling are not Harness activity.
    if (!record(value) || typeof value.method !== "string" || !record(value.params)) return;
    const params = value.params;
    const thread = record(params.thread) ? params.thread : undefined;
    const threadId = typeof params.threadId === "string" ? params.threadId : thread?.id;
    if (typeof threadId !== "string" || !threadId) return;
    const source = record(thread?.source) ? thread.source : undefined;
    const subagent = record(source?.subAgent) ? source.subAgent : undefined;
    const spawn = record(subagent?.thread_spawn) ? subagent.thread_spawn : undefined;
    const parent = typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id : undefined;
    this.note(threadId, parent);
    const item = record(params.item) ? params.item : undefined;
    if (
      item?.type === "collabAgentToolCall" &&
      item.tool === "spawnAgent" &&
      Array.isArray(item.receiverThreadIds)
    ) {
      for (const child of item.receiverThreadIds) {
        if (typeof child === "string" && child) this.note(child, threadId);
      }
    }
  }
}
