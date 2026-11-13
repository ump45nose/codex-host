import { THREAD_OWNERSHIP_LIST_MAX_LENGTH, hostThreadIdSchema } from "@codexhost/shared-contracts";

import type { RendererModelClient } from "./renderer-model-client.js";
import { rendererAgentForThreadOwnership } from "./renderer-sidebar-agent-icons.js";

/** `hostId:threadId` of every thread the Pet shows a card for, published by the Pet. */
export const PETS_CARD_THREADS_STORAGE_KEY = "codexhost.pets-card-threads.v1";

/** A Codex answer may come before Host records an external thread, so it is asked again later. */
const CODEX_OWNERSHIP_TTL_MS = 30_000;

type ReadableStorage = Pick<Storage, "getItem"> | null | undefined;
type WritableStorage = Pick<Storage, "getItem" | "setItem"> | null | undefined;

export function writePetsCardThreads(keys: readonly string[], storage: WritableStorage): void {
  try {
    const next = JSON.stringify([...new Set(keys)].sort());
    if (storage?.getItem(PETS_CARD_THREADS_STORAGE_KEY) !== next)
      storage?.setItem(PETS_CARD_THREADS_STORAGE_KEY, next);
  } catch {}
}

export function readPetsCardThreads(storage: ReadableStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(PETS_CARD_THREADS_STORAGE_KEY) ?? "");
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

const splitKey = (key: string): { hostId: string; threadId: string } | null => {
  const separator = key.lastIndexOf(":");
  return separator > 0 && separator < key.length - 1
    ? { hostId: key.slice(0, separator), threadId: key.slice(separator + 1) }
    : null;
};

export interface PetsCardAgentResolver {
  /**
   * Agents of the Pet's card threads that `known` (the sidebar) does not cover, from Host's
   * thread ownership. Unknown threads are queried in the background; `onResolved` fires when
   * an answer arrives.
   */
  resolve(
    cardThreads: readonly string[],
    known: Readonly<Record<string, string>>,
  ): Record<string, string>;
}

export function createPetsCardAgentResolver(options: {
  readonly getClient: (hostId: string) => RendererModelClient | null;
  readonly onResolved: () => void;
  readonly now?: () => number;
}): PetsCardAgentResolver {
  const now = options.now ?? Date.now;
  const owners = new Map<string, { agent: string; at: number }>();
  const pending = new Set<string>();

  const request = (hostId: string, keys: string[]): void => {
    const client = options.getClient(hostId);
    if (!client) return;
    for (const key of keys) pending.add(key);
    const threadIds = keys.map((key) => hostThreadIdSchema.parse(splitKey(key)?.threadId));
    void Promise.resolve()
      .then(() => client.listThreadOwnership({ threadIds }))
      .then(({ threads }) => {
        for (const ownership of threads)
          owners.set(`${hostId}:${ownership.threadId}`, {
            agent: rendererAgentForThreadOwnership(ownership),
            at: now(),
          });
        options.onResolved();
      })
      .catch(() => {})
      .finally(() => {
        for (const key of keys) pending.delete(key);
      });
  };

  return {
    resolve(cardThreads, known) {
      const agents: Record<string, string> = {};
      const missingByHost = new Map<string, string[]>();
      for (const key of cardThreads) {
        if (known[key]) continue;
        const owner = owners.get(key);
        if (owner && owner.agent !== "codex") {
          agents[key] = owner.agent;
          continue;
        }
        if (pending.has(key) || (owner && now() - owner.at < CODEX_OWNERSHIP_TTL_MS)) continue;
        const parsed = splitKey(key);
        if (!parsed || !hostThreadIdSchema.safeParse(parsed.threadId).success) continue;
        const keys = missingByHost.get(parsed.hostId) ?? [];
        if (keys.length < THREAD_OWNERSHIP_LIST_MAX_LENGTH) keys.push(key);
        missingByHost.set(parsed.hostId, keys);
      }
      for (const [hostId, keys] of missingByHost) request(hostId, keys);
      return agents;
    },
  };
}
