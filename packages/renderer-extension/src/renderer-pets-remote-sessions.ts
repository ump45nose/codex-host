type Row = Record<string, unknown>;
interface Lease {
  [Symbol.dispose](): void;
  onRpcBroken(listener: (error: unknown) => void): void;
}
type Result<T> = Promise<T> & Lease;
export interface PetsNativeRpc {
  subscribe(input: Row & { listener(value: unknown): void }): Result<Lease>;
  getCachedThreadSearchSnapshot(): Result<unknown>;
  getConversation(id: string): Result<unknown>;
}

const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const remote = (hostId: string) => /^remote[-:]/u.test(hostId);
const dispose = (lease: { [Symbol.dispose]?: () => void }) => lease[Symbol.dispose]?.();

/** Extend only the Pet's native recent-threads subscription. Rows and all Turn data still
 * come from Desktop's listState subscriptions; its notification rules render the cards. */
export function petsRemoteSessionsRpc(rpc: PetsNativeRpc, hostId: string): PetsNativeRpc {
  if (!remote(hostId)) return rpc;
  return new Proxy(rpc, {
    get(target, key) {
      if (key !== "subscribe") return Reflect.get(target, key);
      return (input: Row & { listener(value: unknown): void }): Result<Lease> => {
        if (
          input.type !== "host" ||
          input.field !== "recentThreads" ||
          !record(input.key) ||
          input.key.hostId !== hostId
        )
          return rpc.subscribe(input);
        let stopped = false;
        let nativeRows: unknown[] = [];
        let suppressed = new Set<string>();
        let suppressionReady = false;
        let suppressionRevision = 0;
        let scanning = false;
        let dirty = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const leases = new Set<Lease>();
        const broken = new Set<(error: unknown) => void>();
        const threads = new Map<
          string,
          { row?: Row | undefined; allowed: boolean; lease?: Lease }
        >();
        const publish = () => {
          if (stopped) return;
          const ids = new Set(
            nativeRows.flatMap((row) =>
              record(row) && record(row.summary) ? [row.summary.conversationId] : [],
            ),
          );
          input.listener([
            ...nativeRows,
            ...[...threads].flatMap(([id, entry]) => {
              const row = entry.row;
              return suppressionReady &&
                !ids.has(id) &&
                !suppressed.has(id) &&
                entry.allowed &&
                row &&
                row.ephemeral !== true &&
                row.sideConversation !== true &&
                record(row.summary) &&
                row.summary.hostId === hostId &&
                row.summary.workspaceKind === "projectless"
                ? [row]
                : [];
            }),
          ]);
        };
        const stop = () => {
          if (stopped) return;
          stopped = true;
          clearTimeout(timer);
          for (const lease of leases) dispose(lease);
          leases.clear();
          threads.clear();
        };
        const fail = (error: unknown) => {
          if (stopped) return;
          stop();
          for (const listener of broken) listener(error);
        };
        const track = (pending: Result<Lease>): Lease => {
          let settled: Lease | undefined;
          const lease: Lease = {
            onRpcBroken: (listener) => pending.onRpcBroken(listener),
            [Symbol.dispose]() {
              leases.delete(lease);
              dispose(pending);
              if (settled) dispose(settled);
              settled = undefined;
            },
          };
          leases.add(lease);
          pending.onRpcBroken(fail);
          void pending.then((value) => {
            if (!leases.has(lease)) dispose(value);
            else {
              settled = value;
              value.onRpcBroken(fail);
            }
          }, fail);
          return lease;
        };
        const read = async (pending: Result<unknown>) => {
          leases.add(pending);
          try {
            return await pending;
          } finally {
            if (leases.delete(pending)) dispose(pending);
          }
        };
        const scan = async () => {
          timer = undefined;
          if (stopped) return;
          if (scanning) {
            dirty = true;
            return;
          }
          scanning = true;
          try {
            const revision = suppressionRevision;
            const snapshot = await read(rpc.getCachedThreadSearchSnapshot());
            if (stopped) return;
            if (!record(snapshot) || !Array.isArray(snapshot.conversations))
              throw new Error("Native thread search snapshot is unavailable");
            if (revision === suppressionRevision && Array.isArray(snapshot.suppressedIds)) {
              suppressed = new Set(
                snapshot.suppressedIds.filter((id): id is string => typeof id === "string"),
              );
              suppressionReady = true;
            }
            const candidates = new Set<string>();
            for (const value of snapshot.conversations) {
              if (!record(value) || !record(value.summary)) continue;
              const summary = value.summary;
              if (
                summary.hostId === hostId &&
                summary.workspaceKind === "projectless" &&
                typeof summary.conversationId === "string" &&
                value.ephemeral !== true &&
                value.sideConversation !== true
              )
                candidates.add(summary.conversationId);
            }
            for (const [id, entry] of threads) {
              if (candidates.has(id)) continue;
              if (entry.lease) dispose(entry.lease);
              threads.delete(id);
            }
            publish();
            // Native recent-history filtering also excludes attached/side conversations.
            // Read the existing in-memory conversation, never resume or load Harness history.
            for (const id of candidates) {
              const conversation = await read(rpc.getConversation(id));
              if (stopped) return;
              let entry = threads.get(id);
              if (!entry) {
                entry = { allowed: false };
                threads.set(id, entry);
                const owned = entry;
                entry.lease = track(
                  rpc.subscribe({
                    type: "thread",
                    key: { hostId, threadId: id },
                    field: "listState",
                    listener: (row) => {
                      owned.row = record(row) ? row : undefined;
                      publish();
                    },
                  }),
                );
              }
              entry.allowed =
                record(conversation) &&
                conversation.ephemeral !== true &&
                conversation.sideConversation !== true &&
                conversation.attachedToThreadId == null;
            }
            publish();
          } catch {
            // A failed read is not evidence that an omitted conversation is visible.
            for (const entry of threads.values()) entry.allowed = false;
            publish();
          } finally {
            scanning = false;
            if (dirty && !stopped) {
              dirty = false;
              schedule();
            }
          }
        };
        const schedule = () => {
          if (!stopped && timer === undefined) timer = setTimeout(() => void scan(), 250);
        };
        track(
          rpc.subscribe({
            ...input,
            listener: (rows) => {
              nativeRows = Array.isArray(rows) ? rows : [];
              publish();
              schedule();
            },
          }),
        );
        track(
          rpc.subscribe({
            type: "host",
            key: { hostId },
            field: "threadStatuses",
            listener: schedule,
          }),
        );
        track(
          rpc.subscribe({
            type: "host",
            key: { hostId },
            field: "suppressedArchivedThreadIds",
            listener: (ids) => {
              suppressionRevision++;
              suppressionReady = Array.isArray(ids);
              suppressed = new Set(
                Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
              );
              publish();
              schedule();
            },
          }),
        );
        schedule();
        const lease: Lease = { [Symbol.dispose]: stop, onRpcBroken: (fn) => void broken.add(fn) };
        return Object.assign(Promise.resolve(lease), lease);
      };
    },
  });
}

interface Signal {
  get(): unknown;
  set(value: unknown): void;
}

/** Find the mounted app scope through native useScope refs, without importing lazy modules. */
function connectionSignals(document: Document): Signal[] {
  const root = document.getElementById("root");
  const key =
    root && Object.getOwnPropertyNames(root).find((k) => k.startsWith("__reactContainer$"));
  const stack: unknown[] = [root && key ? Reflect.get(root, key) : null];
  const seen = new Set<unknown>();
  while (stack.length && seen.size < 50_000) {
    const fiber = stack.pop();
    if (!record(fiber) || seen.has(fiber)) continue;
    seen.add(fiber);
    stack.push(fiber.child, fiber.sibling);
    let hook = fiber.memoizedState;
    for (let i = 0; record(hook) && "next" in hook && i < 150; i++, hook = hook.next) {
      const ref = record(hook.memoizedState) ? hook.memoizedState.current : null;
      if (
        !record(ref) ||
        !record(ref.node) ||
        !("chain" in ref) ||
        !("scope" in ref) ||
        typeof ref.get !== "function" ||
        typeof ref.set !== "function" ||
        typeof ref.watch !== "function"
      )
        continue;
      let node = ref.node;
      const parents = new Set<unknown>();
      while (record(node.parent) && !parents.has(node.parent)) {
        parents.add(node);
        node = node.parent;
      }
      if (!(node.familyBindings instanceof Map)) continue;
      const families: Signal[][] = [];
      for (const [definition, members] of node.familyBindings) {
        if (!record(definition) || definition.kind !== "signal-family" || !(members instanceof Map))
          continue;
        const signals: Signal[] = [];
        for (const [hostId, member] of members) {
          if (typeof hostId !== "string" || !remote(hostId) || !record(member)) continue;
          const signal = member.value as Signal | undefined;
          if (typeof signal?.get !== "function" || typeof signal.set !== "function") continue;
          let value: unknown;
          try {
            value = signal.get();
          } catch {
            continue;
          }
          if (
            record(value) &&
            typeof value.status === "string" &&
            record(value.client) &&
            value.client.hostId === hostId &&
            "rpc" in value.client
          )
            signals.push(signal);
        }
        if (signals.length) families.push(signals);
      }
      return families.length === 1 ? (families[0] ?? []) : [];
    }
  }
  return [];
}

export function installPetsRemoteSessions(win: Window): () => void {
  const owned = new Map<Signal, { original: Row; wrapped: Row }>();
  const reconcile = () => {
    for (const signal of connectionSignals(win.document)) {
      const value = signal.get();
      if (owned.get(signal)?.wrapped === value) continue;
      owned.delete(signal);
      if (!record(value) || value.status !== "ready" || !record(value.client)) continue;
      const { hostId, rpc } = value.client;
      if (typeof hostId !== "string" || (!record(rpc) && typeof rpc !== "function")) continue;
      const wrapped = {
        ...value,
        client: {
          ...value.client,
          rpc: petsRemoteSessionsRpc(rpc as unknown as PetsNativeRpc, hostId),
        },
      };
      owned.set(signal, { original: value, wrapped });
      signal.set(wrapped);
    }
  };
  const timer = win.setInterval(reconcile, 1_000);
  reconcile();
  return () => {
    win.clearInterval(timer);
    for (const [signal, entry] of owned)
      if (signal.get() === entry.wrapped) signal.set(entry.original);
    owned.clear();
  };
}
