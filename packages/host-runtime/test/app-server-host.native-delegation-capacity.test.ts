import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";

import type { PersistedQueuedDelegation } from "../src/delegation-capacity-store.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import type { DelegationControlRegistration } from "../src/delegation-types.js";
import {
  createFixture,
  readJsonLine,
  requestId,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

type Fixture = ReturnType<typeof createFixture>;

/** Answers the Host's requests to the native backend; `turns` holds each Thread's Turn IDs. */
function serveOfficial(fixture: Fixture, threadIds: string[]) {
  const seen: JsonObject[] = [];
  const turns = new Map<string, string[]>();
  let stopped = false;
  let nextTurn = 0;
  const answer = (request: JsonObject): JsonObject => {
    const params = (request.params ?? {}) as JsonObject;
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    switch (request.method) {
      case "thread/start": {
        const id = threadIds.shift();
        if (!id) throw new Error("No synthetic native Thread left");
        return { thread: { id, cwd: "/synthetic" } };
      }
      case "thread/read":
        return {
          thread: {
            id: threadId,
            cwd: "/synthetic",
            ...(params.includeTurns
              ? { turns: (turns.get(threadId) ?? []).map((id) => ({ id, status: "inProgress" })) }
              : {}),
          },
        };
      case "thread/resume":
        return { thread: { id: threadId, cwd: "/synthetic" } };
      case "turn/start": {
        const id = `turn-${nextTurn++}`;
        turns.set(threadId, [...(turns.get(threadId) ?? []), id]);
        return { turn: { id, status: "inProgress" } };
      }
      default:
        return {};
    }
  };
  const loop = (async () => {
    while (!stopped) {
      let request: JsonObject;
      try {
        request = await readJsonLine(fixture.official.stdin, 50);
      } catch {
        continue;
      }
      seen.push(request);
      if (request.id !== undefined) {
        fixture.official.stdout.write(
          `${JSON.stringify({ id: request.id, result: answer(request) })}\n`,
        );
      }
    }
  })();
  return {
    seen,
    turns,
    calls: (method: string, threadId: string) =>
      seen.filter(
        (entry) =>
          entry.method === method &&
          (entry.params as JsonObject | undefined)?.threadId === threadId,
      ),
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

function official(fixture: Fixture, method: string, params: JsonObject): void {
  fixture.official.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

async function limit(fixture: Fixture, maxRunning: number, id = 900): Promise<void> {
  writeRequest(fixture.desktopInput, {
    id,
    method: "codexhost/settings/delegation-capacity/set",
    params: { enabled: true, maxRunning },
  });
  await fixture.collector.waitFor((message) => requestId(message, id));
}

function setup(store?: {
  adopt(): Promise<PersistedQueuedDelegation[]>;
  save(entries: readonly PersistedQueuedDelegation[]): Promise<void>;
}) {
  const registry = new DelegationControlRegistry({
    capacity: { pollIntervalMs: 10, ...(store ? { store } : {}) },
  });
  let registration: DelegationControlRegistration | undefined;
  const fixture = createFixture({
    onDelegationApi: (api) => {
      registration = api;
      return registry.register(api);
    },
  });
  return { registry, fixture, running: () => registration?.runningThreadIds?.() ?? [] };
}

describe("AppServerHost native delegation capacity", () => {
  it("queues native Codex starts in Threads created up front and starts them in order", async () => {
    const { registry, fixture, running } = setup();
    const backend = serveOfficial(fixture, ["queued-native", "second-native", "third-native"]);
    try {
      await fixture.ready;
      await limit(fixture, 1);
      official(fixture, "turn/started", { threadId: "native-top", turn: { id: "top-turn" } });
      await vi.waitFor(() => expect(running()).toEqual(["native-top"]));

      const first = await registry.start({
        harnessId: "codex",
        task: "queued native work",
        parentThreadId: "native-top",
      });
      expect(first).toMatchObject({
        threadId: "queued-native",
        harnessId: "codex",
        deepLink: "codex://threads/queued-native",
        status: "queued",
        queue: { position: 1 },
      });
      expect(backend.calls("thread/name/set", "queued-native")).toHaveLength(1);
      const second = await registry.start({
        harnessId: "codex",
        task: "second native work",
        parentThreadId: "native-top",
      });
      expect(second).toMatchObject({ threadId: "second-native", queue: { position: 2 } });
      // A retry of a waiting start returns it without creating another Thread.
      expect(
        await registry.start({
          harnessId: "codex",
          task: "second native work",
          parentThreadId: "native-top",
        }),
      ).toMatchObject({ threadId: "second-native", status: "queued", queue: { position: 2 } });
      expect(backend.seen.filter((entry) => entry.method === "thread/start")).toHaveLength(2);
      expect(backend.seen.some((entry) => entry.method === "turn/start")).toBe(false);

      expect(await registry.read({ threadId: "queued-native", view: "result" })).toMatchObject({
        status: "queued",
        queue: { position: 1 },
      });
      await expect(
        registry.send({ threadId: "queued-native", message: "more" }),
      ).rejects.toMatchObject({ code: "THREAD_BUSY" });

      expect(await registry.cancel({ threadId: "second-native" })).toMatchObject({
        cancelled: true,
      });
      expect(backend.calls("thread/delete", "second-native")).toHaveLength(1);
      expect(await registry.read({ threadId: "second-native", view: "result" })).toMatchObject({
        status: "interrupted",
      });

      official(fixture, "turn/completed", {
        threadId: "native-top",
        turn: { id: "top-turn", status: "completed" },
      });
      await vi.waitFor(() => expect(running()).toEqual(["queued-native"]), { timeout: 5_000 });
      expect(backend.calls("thread/resume", "queued-native")).toHaveLength(1);
      expect(backend.calls("turn/start", "queued-native")).toMatchObject([
        {
          params: {
            threadId: "queued-native",
            input: [{ type: "text", text: "queued native work" }],
          },
        },
      ]);
      // The identity returned while queued now reads the native Thread itself.
      await vi.waitFor(async () =>
        expect(await registry.read({ threadId: "queued-native", view: "result" })).toMatchObject({
          threadId: "queued-native",
          harnessId: "codex",
          status: "running",
        }),
      );
      expect(await registry.capacity.claim("queued-native", "codex")).toBeUndefined();

      // The slot is taken again; the next native start waits behind it.
      const third = await registry.start({
        harnessId: "codex",
        task: "third native work",
        parentThreadId: "queued-native",
      });
      expect(third).toMatchObject({ threadId: "third-native", status: "queued" });
    } finally {
      registry.close();
      await backend.stop();
      await stopFixture(fixture);
    }
  });

  it("starts the queued task with a user message sent to the waiting Thread, only once", async () => {
    const { registry, fixture, running } = setup();
    const backend = serveOfficial(fixture, ["claimed-native"]);
    try {
      await fixture.ready;
      await limit(fixture, 1);
      official(fixture, "turn/started", { threadId: "native-top", turn: { id: "top-turn" } });
      await vi.waitFor(() => expect(running()).toEqual(["native-top"]));
      const queued = await registry.start({
        harnessId: "codex",
        task: "queued native work",
        parentThreadId: "native-top",
      });
      expect(queued).toMatchObject({ threadId: "claimed-native", status: "queued" });

      writeRequest(fixture.desktopInput, {
        id: 950,
        method: "turn/start",
        params: { threadId: "claimed-native", input: [{ type: "text", text: "user message" }] },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 950))).toMatchObject({
        result: { turn: { id: "turn-0" } },
      });
      expect(backend.calls("turn/start", "claimed-native")).toMatchObject([
        {
          params: {
            input: [
              { type: "text", text: "queued native work" },
              { type: "text", text: "user message" },
            ],
          },
        },
      ]);
      expect(await registry.capacity.claim("claimed-native", "codex")).toBeUndefined();

      official(fixture, "turn/completed", {
        threadId: "native-top",
        turn: { id: "top-turn", status: "completed" },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(backend.calls("turn/start", "claimed-native")).toHaveLength(1);
    } finally {
      registry.close();
      await backend.stop();
      await stopFixture(fixture);
    }
  });

  it("resumes a restored native start without starting a Turn that already began", async () => {
    const record = (threadId: string, task: string, starting?: boolean) => ({
      delegationId: `delegation-${threadId}`,
      threadId,
      turnId: "pending",
      harnessId: "codex" as const,
      task,
      cwd: "/synthetic",
      parentThreadId: "native-top",
      title: task,
      taskDigest: task,
      queuedAt: Date.now(),
      ...(starting ? { starting } : {}),
    });
    const saved: (readonly PersistedQueuedDelegation[])[] = [];
    const { registry, fixture, running } = setup({
      adopt: async () => [
        record("begun-native", "begun work", true),
        record("waiting-native", "waiting work"),
      ],
      save: async (entries) => {
        saved.push(entries);
      },
    });
    const backend = serveOfficial(fixture, []);
    backend.turns.set("begun-native", ["begun-turn"]);
    try {
      await fixture.ready;
      expect(await registry.read({ threadId: "begun-native", view: "result" })).toMatchObject({
        status: "queued",
        queue: { position: 1 },
      });
      await limit(fixture, 4);
      await vi.waitFor(() => expect(running()).toEqual(["waiting-native"]), { timeout: 5_000 });
      expect(backend.calls("thread/resume", "begun-native")).toHaveLength(1);
      expect(backend.calls("turn/start", "begun-native")).toHaveLength(0);
      expect(backend.calls("turn/start", "waiting-native")).toMatchObject([
        { params: { input: [{ type: "text", text: "waiting work" }] } },
      ]);
      await vi.waitFor(() => expect(saved.at(-1)).toEqual([]));
    } finally {
      registry.close();
      await backend.stop();
      await stopFixture(fixture);
    }
  });
});
