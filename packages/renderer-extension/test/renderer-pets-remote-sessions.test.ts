// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPetsRemoteSessions,
  petsRemoteSessionsRpc,
  type PetsNativeRpc,
} from "../src/renderer-pets-remote-sessions.js";

type Row = Record<string, unknown>;
type Subscription = Parameters<PetsNativeRpc["subscribe"]>[0];
type Lease = Awaited<ReturnType<PetsNativeRpc["subscribe"]>>;

function nativeHost(hostId: string) {
  const conversations = new Map<string, Row>();
  const rows = new Map<string, Row>();
  const subscriptions = new Set<Subscription>();
  const resources = new Set<Lease>();
  let recent: Row[] = [];
  let suppressed: string[] = [];
  let broken: ((error: unknown) => void)[] = [];
  let rejectSnapshot = false;
  const lease = (onDispose = () => {}) => {
    const resource: Lease = {
      [Symbol.dispose]() {
        resources.delete(resource);
        onDispose();
      },
      onRpcBroken: (fn) => broken.push(fn),
    };
    resources.add(resource);
    return resource;
  };
  const result = <T>(value: T, onDispose = () => {}) =>
    Object.assign(Promise.resolve(value), lease(onDispose));
  const emit = (field: string, value: unknown, id?: string) => {
    for (const sub of subscriptions) {
      if (sub.field === field && (!id || (sub.key as Row).threadId === id)) sub.listener(value);
    }
  };
  const rpc: PetsNativeRpc = {
    subscribe(input) {
      subscriptions.add(input);
      if (input.field === "recentThreads") input.listener(recent);
      if (input.field === "suppressedArchivedThreadIds") input.listener(suppressed);
      if (input.field === "threadStatuses") input.listener([]);
      if (input.field === "listState")
        input.listener(rows.get((input.key as Row).threadId as string));
      return result(
        lease(() => subscriptions.delete(input)),
        () => subscriptions.delete(input),
      );
    },
    getCachedThreadSearchSnapshot() {
      const response = result({
        conversations: [...rows.values()],
        suppressedIds: suppressed,
      });
      if (!rejectSnapshot) return response;
      return Object.assign(Promise.reject(new Error("snapshot unavailable")), {
        [Symbol.dispose]: response[Symbol.dispose],
        onRpcBroken: response.onRpcBroken,
      });
    },
    getConversation(id) {
      return result(conversations.get(id));
    },
  };
  const add = (id: string, options: { row?: Row; summary?: Row; conversation?: Row } = {}) => {
    const row = {
      summary: { conversationId: id, hostId, workspaceKind: "projectless", ...options.summary },
      isConversationInProgress: true,
      ...options.row,
    };
    rows.set(id, row);
    conversations.set(id, { id, ...options.conversation });
    return row;
  };
  return {
    rpc,
    rows,
    conversations,
    resources,
    subscriptions,
    add,
    emit,
    fail() {
      const listeners = broken;
      broken = [];
      for (const fn of listeners) fn(new Error("disconnected"));
    },
    rejectSnapshot: () => {
      rejectSnapshot = true;
    },
    recent(value: Row[]) {
      recent = value;
      emit("recentThreads", value);
    },
    suppress(value: string[]) {
      suppressed = value;
      emit("suppressedArchivedThreadIds", value);
    },
  };
}

const disposers: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await Promise.resolve();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function watch(rpc: PetsNativeRpc, hostId: string) {
  let rows: unknown[] = [];
  const pending = rpc.subscribe({
    type: "host",
    key: { hostId },
    field: "recentThreads",
    listener: (value) => {
      rows = value as unknown[];
    },
  });
  disposers.push(() => {
    pending[Symbol.dispose]();
    void pending.then((lease) => lease[Symbol.dispose]());
  });
  return { rows: () => rows, pending };
}

describe("Pet remote projectless candidates", () => {
  it.each(["remote-ssh-discovered:nas", "remote:device-id"])(
    "includes native Codex and external Harness rows on %s with live native state",
    async (hostId) => {
      vi.useFakeTimers();
      const host = nativeHost(hostId);
      const codex = host.add("codex", { summary: { modelProvider: "openai" } });
      const agy = host.add("agy", { summary: { modelProvider: "codexhost" } });
      const project = host.add("project", { summary: { workspaceKind: "local" } });
      host.recent([project]);
      const view = watch(petsRemoteSessionsRpc(host.rpc, hostId), hostId);
      await vi.advanceTimersByTimeAsync(250);
      expect(view.rows()).toEqual([project, codex, agy]);
      expect(view.rows()[2]).toBe(agy);

      const completed = { ...agy, isConversationInProgress: false, unreadMessageCount: 1 };
      host.emit("listState", completed, "agy");
      expect(view.rows()).toEqual([project, codex, completed]);
      host.recent([project, completed]);
      expect(view.rows()).toEqual([project, completed, codex]);

      host.rows.delete("codex");
      host.emit("threadStatuses", []);
      await vi.advanceTimersByTimeAsync(250);
      expect(view.rows()).toEqual([project, completed]);
      host.add("new");
      host.emit("threadStatuses", []);
      await vi.advanceTimersByTimeAsync(250);
      expect(view.rows()).toEqual([project, completed, host.rows.get("new")]);
    },
  );

  it("preserves native exclusions, including archives, attached and ephemeral conversations", async () => {
    vi.useFakeTimers();
    const hostId = "remote-ssh-discovered:nas";
    const host = nativeHost(hostId);
    const visible = host.add("visible");
    host.add("archived");
    host.add("ephemeral", { row: { ephemeral: true } });
    host.add("side", { row: { sideConversation: true } });
    host.add("attached", { conversation: { attachedToThreadId: "parent" } });
    host.add("conversation-ephemeral", { conversation: { ephemeral: true } });
    host.add("other-host", { summary: { hostId: "local" } });
    host.add("project", { summary: { workspaceKind: "local" } });
    host.suppress(["archived"]);
    const view = watch(petsRemoteSessionsRpc(host.rpc, hostId), hostId);
    await vi.advanceTimersByTimeAsync(250);
    expect(view.rows()).toEqual([visible]);

    host.suppress(["visible", "archived"]);
    expect(view.rows()).toEqual([]);
    host.suppress([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(view.rows()).toEqual([visible, host.rows.get("archived")]);
    host.rows.set("archived", { ...host.rows.get("archived"), sideConversation: true });
    host.emit("listState", host.rows.get("archived"), "archived");
    expect(view.rows()).toEqual([visible]);
  });

  it("leaves local projectless and unrelated native subscriptions unchanged", async () => {
    vi.useFakeTimers();
    const local = nativeHost("local");
    local.add("local-projectless");
    expect(petsRemoteSessionsRpc(local.rpc, "local")).toBe(local.rpc);
    const view = watch(petsRemoteSessionsRpc(local.rpc, "local"), "local");
    await vi.advanceTimersByTimeAsync(500);
    expect(view.rows()).toEqual([]);

    const remote = nativeHost("remote:nas");
    const rpc = petsRemoteSessionsRpc(remote.rpc, "remote:nas");
    const row = remote.add("existing");
    let received: unknown;
    const pending = rpc.subscribe({
      type: "thread",
      key: { hostId: "remote:nas", threadId: "existing" },
      field: "listState",
      listener: (value) => {
        received = value;
      },
    });
    expect(received).toBe(row);
    pending[Symbol.dispose]();
    (await pending)[Symbol.dispose]();
  });

  it("keeps the native feed on snapshot failure and disposes subscriptions and in-flight leases", async () => {
    vi.useFakeTimers();
    const hostId = "remote:nas";
    const host = nativeHost(hostId);
    host.add("missing");
    const project = host.add("project", { summary: { workspaceKind: "local" } });
    host.recent([project]);
    const view = watch(petsRemoteSessionsRpc(host.rpc, hostId), hostId);
    await vi.advanceTimersByTimeAsync(250);
    host.rejectSnapshot();
    host.emit("threadStatuses", []);
    await vi.advanceTimersByTimeAsync(250);
    expect(view.rows()).toEqual([project]);
    view.pending[Symbol.dispose]();
    (await view.pending)[Symbol.dispose]();
    await Promise.resolve();
    expect(host.subscriptions.size).toBe(0);
    expect(host.resources.size).toBe(0);

    const retry = watch(petsRemoteSessionsRpc(host.rpc, hostId), hostId);
    const error = vi.fn();
    retry.pending.onRpcBroken(error);
    host.fail();
    await vi.advanceTimersByTimeAsync(500);
    expect(error).toHaveBeenCalledWith(new Error("disconnected"));
    expect(host.subscriptions.size).toBe(0);
    expect(host.resources.size).toBe(0);
  });
});

describe("Pet-only connection hook", () => {
  it("wraps mounted remote connections, reconnects and restores only its own signal values", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    const hostId = "remote-ssh-discovered:nas";
    const host = nativeHost(hostId);
    const original = { status: "ready", client: { hostId, rpc: host.rpc } };
    let current = original;
    const signal = {
      get: () => current,
      set: (value: typeof original) => {
        current = value;
      },
    };
    const local = { get: () => ({ status: "ready", client: { hostId: "local", rpc: host.rpc } }) };
    const family = new Map<string, unknown>([
      [hostId, { value: signal }],
      ["local", { value: local }],
    ]);
    const scope = {
      node: { familyBindings: new Map([[{ kind: "signal-family" }, family]]) },
      chain: [],
      scope: {},
      get() {},
      set() {},
      watch() {},
    };
    Object.assign(root, {
      __reactContainer$test: { memoizedState: { memoizedState: { current: scope }, next: null } },
    });
    const stop = installPetsRemoteSessions(window);
    disposers.push(stop);
    expect(current.client.rpc).not.toBe(original.client.rpc);
    const row = host.add("agy");
    const view = watch(current.client.rpc, hostId);
    await vi.advanceTimersByTimeAsync(250);
    expect(view.rows()).toEqual([row]);

    const reconnected = {
      ...original,
      client: { ...original.client, rpc: nativeHost(hostId).rpc },
    };
    current = reconnected;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(current.client.rpc).not.toBe(reconnected.client.rpc);
    stop();
    expect(current).toBe(reconnected);

    const again = installPetsRemoteSessions(window);
    current = original;
    again();
    expect(current).toBe(original);
  });
});
