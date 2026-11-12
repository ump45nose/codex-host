import { execFileSync } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { setImmediate as nextFrame } from "node:timers/promises";
import type { JsonObject, JsonRpcId } from "@codexhost/protocol-core";
import { describe, expect, it, vi } from "vitest";
import { SharedThreadBridge } from "../src/shared-thread-bridge.js";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";
import { StreamThreadPeer } from "../src/shared-thread-peer.js";

function fixture() {
  const owner = new SharedThreadOwner();
  return {
    owner,
    dispose() {
      owner.close();
      owner.output.end();
    },
  };
}

function collect(stream: Readable): JsonObject[] {
  const messages: JsonObject[] = [];
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) messages.push(JSON.parse(line));
  });
  return messages;
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing fixture value at ${index}`);
  return value;
}

function requestId(message: JsonObject): JsonRpcId {
  const id = message.id;
  if (typeof id !== "string" && typeof id !== "number") throw new Error("Missing request ID");
  return id;
}

function interactionFixture() {
  const value = fixture();
  const requests = collect(value.owner.input);
  const emit = (message: JsonObject): void => {
    value.owner.output.write(`${JSON.stringify(message)}\n`);
  };
  const resume = async (peer: ReturnType<SharedThreadOwner["connect"]>, threadId: string) => {
    const offset = requests.length;
    const response = peer.request("thread/resume", { threadId });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(offset));
    emit({ id: requestId(at(requests, offset)), result: { thread: { id: threadId } } });
    await response;
    await nextFrame();
  };
  return { ...value, requests, emit, resume };
}

describe("shared Thread pending interactions", () => {
  it("replays only the resumed Thread's questions and approvals after its wire response", async () => {
    const { owner, requests, emit, dispose } = interactionFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const messages = collect(output);
    const retired = owner.connect();
    const initial: JsonObject[] = [];
    retired.subscribe((message) => initial.push(message));
    const methods = [
      "item/tool/requestUserInput",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ];
    for (const [id, method] of methods.entries()) {
      emit({ id, method, params: { threadId: "target", turnId: "turn" } });
    }
    emit({ id: 10, method: at(methods, 0), params: { threadId: "other" } });
    await vi.waitFor(() => expect(initial).toHaveLength(4));
    retired.close();
    const session = owner.createSession({ input, output, diagnosticOutput: new PassThrough() });
    const running = session.run();
    try {
      await nextFrame();
      expect(messages).toEqual([]);
      input.write(
        `${JSON.stringify({ id: 50, method: "thread/resume", params: { threadId: "target" } })}\n`,
      );
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      emit({ id: requestId(at(requests, 0)), result: { thread: { id: "target" } } });
      await vi.waitFor(() => expect(messages).toHaveLength(4));
      expect(messages[0]).toMatchObject({ id: 50, result: { thread: { id: "target" } } });
      expect(messages.slice(1)).toEqual(initial.slice(0, 3));
    } finally {
      input.end();
      await running;
      dispose();
    }
  });

  it.each(["before", "after"])(
    "deduplicates a live request batched %s the resume response through the stream bridge",
    async (order) => {
      const { owner, requests, emit, dispose } = interactionFixture();
      const input = new PassThrough();
      const output = new PassThrough();
      const session = owner.createSession({ input, output, diagnosticOutput: new PassThrough() });
      const running = session.run();
      const peer = new StreamThreadPeer(output, input, () => input.end());
      const bridge = new SharedThreadBridge({
        connect: async () => peer,
        delegateCreates: false,
        diagnose: () => undefined,
      });
      const messages: JsonObject[] = [];
      const request = {
        id: "native",
        method: "item/tool/requestUserInput",
        params: { conversationId: "target", turnId: "turn" },
      };
      bridge.start((message) => messages.push(message));
      try {
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        emit({
          id: requestId(at(requests, 0)),
          result: { data: [{ id: "target" }], nextCursor: null },
        });
        await vi.waitFor(() => expect(messages).toHaveLength(1));
        messages.length = 0;
        for (const round of [0, 1]) {
          const id = 50 + round;
          const response = bridge.route({
            id,
            method: "thread/resume",
            params: { threadId: "target" },
          });
          await vi.waitFor(() => expect(requests).toHaveLength(round + 2));
          const reply = { id: requestId(at(requests, round + 1)), result: {} };
          const batch =
            round === 1 ? [reply] : order === "before" ? [request, reply] : [reply, request];
          owner.output.write(`${batch.map((message) => JSON.stringify(message)).join("\n")}\n`);
          const result = await response;
          if (!result) throw new Error("Expected shared resume response");
          messages.push(result);
          await nextFrame();
          await nextFrame();
        }
        const replayId = requestId(at(messages, 1));
        expect(replayId).toMatch(/^shared-interaction:/);
        expect(messages.map((message) => message.id)).toEqual([50, replayId, 51, replayId]);
      } finally {
        bridge.close();
        await running;
        output.end();
        dispose();
      }
    },
  );

  it("claims concurrent answers once and broadcasts one resolution to every client", async () => {
    const { owner, requests, emit, resume, dispose } = interactionFixture();
    const peers = [owner.connect(), owner.connect()];
    const messages = peers.map((peer) => {
      const events: JsonObject[] = [];
      peer.subscribe((message) => events.push(message));
      return events;
    });
    try {
      emit({ id: 7, method: "item/tool/requestUserInput", params: { threadId: "target" } });
      await vi.waitFor(() => expect(messages[0]).toHaveLength(1));
      const firstMessages = at(messages, 0);
      const original = at(firstMessages, 0);
      const id = requestId(original);
      await Promise.all(
        peers.map((peer, index) =>
          peer.respond({ id, result: { answer: index === 0 ? "first" : "second" } }),
        ),
      );
      expect(requests).toEqual([{ id: 7, result: { answer: "first" } }]);
      for (const events of messages) {
        expect(events).toEqual([
          original,
          { method: "serverRequest/resolved", params: { requestId: id, threadId: "target" } },
        ]);
      }
      emit({ method: "serverRequest/resolved", params: { requestId: 7, threadId: "target" } });
      await nextFrame();
      expect(messages[0]).toHaveLength(2);
      firstMessages.length = 0;
      await resume(at(peers, 0), "target");
      expect(messages[0]).toEqual([]);
    } finally {
      dispose();
    }
  });

  it.each(["turn/completed", "turn/aborted", "turn/failed"])(
    "expires only the finished Turn and unscoped interactions on %s",
    async (method) => {
      const { owner, emit, resume, dispose } = interactionFixture();
      const peer = owner.connect();
      const messages: JsonObject[] = [];
      peer.subscribe((message) => messages.push(message));
      try {
        for (const [id, params] of [
          { threadId: "target", turnId: "finished" },
          { threadId: "target", turnId: "active" },
          { threadId: "target" },
          { threadId: "other", turnId: "finished" },
        ].entries()) {
          emit({ id, method: "item/fileChange/requestApproval", params });
        }
        await vi.waitFor(() => expect(messages).toHaveLength(4));
        const active = messages[1];
        const other = messages[3];
        emit({ method, params: { threadId: "target", turnId: "finished" } });
        await vi.waitFor(() => expect(messages).toHaveLength(5));
        messages.length = 0;
        await resume(peer, "target");
        expect(messages).toEqual([active]);
        messages.length = 0;
        await resume(peer, "other");
        expect(messages).toEqual([other]);
      } finally {
        dispose();
      }
    },
  );
});

describe("shared Thread owner lifetime", () => {
  it("closes every live peer on shutdown, including peers connected after shutdown", async () => {
    const { owner, dispose } = fixture();
    try {
      const first = owner.connect();
      const peers = [first, owner.connect(), owner.connect()];
      first.close();
      owner.close();
      owner.close();
      peers.push(owner.connect());
      await Promise.all(peers.map((peer) => peer.closed));
      for (const peer of peers) {
        await expect(peer.request("thread/list", {})).rejects.toThrow("closed");
      }
    } finally {
      dispose();
    }
  });

  it("closes viewers when the underlying Host output ends", async () => {
    const { owner, dispose } = fixture();
    try {
      const peer = owner.connect();
      owner.output.end();
      await peer.closed;
      await expect(peer.request("thread/list", {})).rejects.toThrow("closed");
    } finally {
      dispose();
    }
  });

  it("detaches one viewer without closing or notifying the others", async () => {
    const { owner, dispose } = fixture();
    try {
      const retired = owner.connect();
      const live = owner.connect();
      const retiredListener = vi.fn();
      const liveListener = vi.fn();
      retired.subscribe(retiredListener);
      live.subscribe(liveListener);
      retired.close();
      const message = { method: "thread/started", params: { thread: { id: "external" } } };
      owner.output.write(`${JSON.stringify(message)}\n`);
      await vi.waitFor(() => expect(liveListener).toHaveBeenCalledWith(message));
      expect(retiredListener).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("allows closed viewers to be collected while the owner remains alive", () => {
    // An isolated process exposes GC without changing the test runner's V8 flags.
    // Workspace tests build dist first; the child exercises that production module.
    const moduleUrl = new URL("../dist/shared-thread-owner.js", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--expose-gc",
        "--input-type=module",
        "-e",
        `
          import { setImmediate } from 'node:timers/promises';
          import { SharedThreadOwner } from ${JSON.stringify(moduleUrl)};
          const owner = new SharedThreadOwner();
          function closedViewers() {
            return Array.from({ length: 1000 }, () => {
              const peer = owner.connect();
              peer.close();
              return new WeakRef(peer);
            });
          }
          const refs = closedViewers();
          for (let i = 0; i < 10; i++) {
            await setImmediate();
            global.gc();
          }
          const retained = refs.filter(ref => ref.deref() !== undefined).length;
          const live = owner.connect();
          const received = new Promise(resolve => live.subscribe(resolve));
          owner.output.write(JSON.stringify({ method: 'audit/alive', params: {} }) + '\\n');
          await received;
          owner.close();
          owner.output.end();
          console.log(JSON.stringify({ retained }));
        `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual({ retained: 0 });
  });
});
