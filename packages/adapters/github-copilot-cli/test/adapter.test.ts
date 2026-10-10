import { describe, expect, it, vi } from "vitest";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { HarnessOutput, HostThreadSnapshot } from "@codexhost/harness-adapter";
import {
  harnessInspectionSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { GitHubCopilotAdapter } from "../src/adapter.js";
import type { CopilotClient, CopilotClientOptions } from "../src/acp-client.js";
import { copilotModelRef } from "../src/configuration.js";

const sessionId = "11111111-1111-1111-1111-111111111111";
const info = {
  sessionId,
  configOptions: [
    {
      type: "select",
      id: "model",
      currentValue: "auto",
      options: [
        { value: "auto", name: "Auto" },
        { value: "gpt-5-mini", name: "GPT-5 mini" },
      ],
    },
    {
      type: "select",
      id: "reasoning_effort",
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
    {
      type: "select",
      id: "allow_all",
      currentValue: "off",
      options: [
        { value: "on", name: "On" },
        { value: "off", name: "Off" },
      ],
    },
  ],
};
const ref = nativeSessionRefSchema.parse({
  harnessId: "github-copilot-cli",
  nativeSessionId: sessionId,
  locator: { cwd: process.cwd() },
  formatVersion: 1,
});
const nativeTurnRef = nativeTurnRefSchema.parse({
  harnessId: ref.harnessId,
  nativeSessionId: sessionId,
  nativeTurnKey: "user-event-1",
  formatVersion: 1,
});

class FakeClient implements CopilotClient {
  readonly calls: string[] = [];
  readonly options: CopilotClientOptions;
  deferred = false;
  settleOnCancel = true;
  resolveTurn?: (value: Record<string, unknown>) => void;
  rejectTurn?: (reason: Error) => void;
  closed = false;
  constructor(options: CopilotClientOptions) {
    this.options = options;
  }
  async initialize() {
    return { agentCapabilities: { loadSession: true } };
  }
  async open(_cwd: string, session?: string) {
    return { ...info, ...(session ? { sessionId: session } : {}) };
  }
  async prompt(_session: string, text: string) {
    this.calls.push(`prompt:${text}`);
    if (!this.deferred) return { stopReason: "end_turn" };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.resolveTurn = resolve;
      this.rejectTurn = reject;
    });
  }
  async cancel() {
    this.calls.push("cancel");
    if (this.settleOnCancel) this.resolveTurn?.({ stopReason: "cancelled" });
  }
  async setConfigOption(_session: string, key: string, value: string) {
    this.calls.push(`${key}:${value}`);
    return {
      configOptions: info.configOptions.map((option) =>
        option.id === key ? { ...option, currentValue: value } : option,
      ),
    };
  }
  async close() {
    this.closed = true;
    this.rejectTurn?.(new Error("ACP connection closed"));
  }
}
function setup() {
  const clients: FakeClient[] = [];
  const turns: HostThreadSnapshot["turns"] = [];
  const history = vi.fn(async (): Promise<HostThreadSnapshot> => ({
    turns: structuredClone(turns),
  }));
  const adapter = new GitHubCopilotAdapter({
    clientFactory: (options) => {
      const client = new FakeClient(options);
      clients.push(client);
      return client;
    },
    readHistory: history,
  });
  return {
    adapter,
    clients,
    history,
    append(text: string) {
      turns.push({
        nativeTurnRef,
        input: [{ type: "text", text }],
        items: [],
        outcome: { status: "unknown", reason: "native" },
      });
    },
  };
}
async function collect(session: { outputs: AsyncIterable<HarnessOutput> }) {
  const outputs: HarnessOutput[] = [];
  const pending = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return { outputs, pending };
}
async function finished(outputs: HarnessOutput[], count = 1) {
  await vi.waitFor(() =>
    expect(
      outputs.filter((o) => o.kind === "event" && o.event.type === "turn.completed"),
    ).toHaveLength(count),
  );
  return outputs.filter((o) => o.kind === "event" && o.event.type === "turn.completed");
}

describe("Copilot Harness adapter", () => {
  it("inspects native configuration and resumes only matching known Turn IDs", async () => {
    const f = setup();
    expect(
      harnessInspectionSchema.parse(await f.adapter.inspect({ cwd: process.cwd() })).status,
    ).toBe("ready");
    f.append("hello");
    const opened = await f.adapter.open({
      kind: "resume",
      cwd: process.cwd(),
      nativeRef: ref,
      knownTurnRefs: [nativeTurnRef],
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.initialState.nativeRef).toEqual(ref);
      await opened.value.close();
    }
    const missing = await f.adapter.open({
      kind: "resume",
      cwd: process.cwd(),
      nativeRef: ref,
      knownTurnRefs: [{ ...nativeTurnRef, nativeTurnKey: "missing" }],
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    await f.adapter.close();
    expect(f.clients.every((client) => client.closed)).toBe(true);
  });

  it("inspects per-Model native Thinking levels instead of borrowing the default Model's", async () => {
    class ModelSpecificClient extends FakeClient {
      selectedModel = "gpt-5-mini";
      override async open() {
        return this.response();
      }
      override async setConfigOption(_session: string, key: string, value: string) {
        this.calls.push(`${key}:${value}`);
        if (key === "model") this.selectedModel = value;
        return this.response();
      }
      response() {
        const levels =
          this.selectedModel === "gpt-6-sol"
            ? ["none", "low", "medium", "high", "xhigh", "max"]
            : this.selectedModel === "gpt-5-mini"
              ? ["low", "medium", "high"]
              : [];
        return {
          sessionId,
          configOptions: [
            {
              type: "select",
              id: "model",
              currentValue: this.selectedModel,
              options: [
                { value: "auto", name: "Auto" },
                { value: "gpt-5-mini", name: "GPT-5 mini" },
                { value: "gpt-6-sol", name: "GPT-6 Sol" },
              ],
            },
            ...(levels.length
              ? [
                  {
                    type: "select",
                    id: "reasoning_effort",
                    currentValue: "medium",
                    options: levels.map((value) => ({ value, name: value })),
                  },
                ]
              : []),
          ],
        };
      }
    }
    const clients: ModelSpecificClient[] = [];
    const adapter = new GitHubCopilotAdapter({
      clientFactory: (options) => {
        const client = new ModelSpecificClient(options);
        clients.push(client);
        return client;
      },
    });
    try {
      const inspected = await adapter.inspect({ cwd: process.cwd() });
      if (inspected.status !== "ready") throw Error("Native inspection failed");
      expect(
        inspected.catalog.models.map(({ label, supportedThinkingOptionIds }) => ({
          label,
          supportedThinkingOptionIds,
        })),
      ).toEqual([
        { label: "Auto", supportedThinkingOptionIds: undefined },
        { label: "GPT-5 mini", supportedThinkingOptionIds: ["low", "medium", "high"] },
        {
          label: "GPT-6 Sol",
          supportedThinkingOptionIds: ["none", "low", "medium", "high", "xhigh", "max"],
        },
      ]);
      expect(inspected.catalog.thinkingOptions).toEqual(
        ["low", "medium", "high", "none", "xhigh", "max"].map((id) => ({
          id,
          label: id === "xhigh" ? "Extra High" : id.slice(0, 1).toUpperCase() + id.slice(1),
        })),
      );
      expect(clients[0]?.calls).toEqual(["model:auto", "model:gpt-6-sol"]);
      expect(clients[0]?.closed).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("refreshes live Thinking capabilities after switching to an Auto Model", async () => {
    class DynamicClient extends FakeClient {
      selectedModel = "gpt-6-sol";
      override async open() {
        return this.response();
      }
      override async setConfigOption(_session: string, key: string, value: string) {
        this.calls.push(`${key}:${value}`);
        if (key === "model") this.selectedModel = value;
        return this.response();
      }
      response() {
        return {
          sessionId,
          configOptions: [
            {
              type: "select",
              id: "model",
              currentValue: this.selectedModel,
              options: [
                { value: "auto", name: "Auto" },
                { value: "gpt-6-sol", name: "GPT-6 Sol" },
              ],
            },
            ...(this.selectedModel === "auto"
              ? []
              : [
                  {
                    type: "select",
                    id: "reasoning_effort",
                    currentValue: "high",
                    options: [
                      { value: "low", name: "low" },
                      { value: "high", name: "high" },
                    ],
                  },
                ]),
          ],
        };
      }
    }
    const clients: DynamicClient[] = [];
    const adapter = new GitHubCopilotAdapter({
      clientFactory: (options) => {
        const client = new DynamicClient(options);
        clients.push(client);
        return client;
      },
    });
    let session: Awaited<ReturnType<typeof adapter.open>> | undefined;
    try {
      session = await adapter.open({ kind: "create", cwd: process.cwd() });
      if (!session.ok) throw Error(session.error.message);
      const stream = await collect(session.value);
      expect(session.value.capabilities.configuration.selectThinkingOption).toBe(true);
      expect(
        (
          await session.value.execute({
            type: "model.select",
            model: copilotModelRef("auto"),
          })
        ).ok,
      ).toBe(true);
      expect(session.value.capabilities.configuration.selectThinkingOption).toBe(false);
      expect(
        (
          await session.value.execute({
            type: "thinking.select",
            thinkingOptionId: "high" as never,
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await session.value.execute({
            type: "model.select",
            model: copilotModelRef("gpt-6-sol"),
          })
        ).ok,
      ).toBe(true);
      expect(session.value.capabilities.configuration.selectThinkingOption).toBe(true);
      expect(
        (
          await session.value.execute({
            type: "thinking.select",
            thinkingOptionId: "low" as never,
          })
        ).ok,
      ).toBe(false);
      expect(
        stream.outputs.filter(
          (entry) => entry.kind === "event" && entry.event.type === "session.state.changed",
        ),
      ).toHaveLength(2);
      expect(clients[0]?.calls).toEqual(["model:auto", "model:gpt-6-sol", "reasoning_effort:low"]);
      await session.value.close();
      await stream.pending;
    } finally {
      if (session?.ok) await session.value.close();
      await adapter.close();
    }
  });

  it("correlates one persisted user event per successful Turn and keeps configuration native", async () => {
    const f = setup();
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const session = opened.value,
      stream = await collect(session);
    const client = f.clients[0];
    if (!client) throw Error("Missing fake client");
    const selected = await session.execute({
      type: "model.select",
      model: copilotModelRef("gpt-5-mini"),
    });
    expect(selected.ok).toBe(true);
    expect(
      (await session.execute({ type: "thinking.select", thinkingOptionId: "high" as never })).ok,
    ).toBe(true);
    expect(
      (
        await session.execute({
          type: "permissionMode.select",
          permissionModeId: "supervised" as never,
        })
      ).ok,
    ).toBe(true);
    client.deferred = true;
    const turnId = hostTurnIdSchema.parse("copilot-turn-1");
    expect(
      (
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "hello" }],
        })
      ).ok,
    ).toBe(true);
    expect(await session.readSnapshot()).toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    for (const command of [
      { type: "model.select", model: copilotModelRef("gpt-5-mini") },
      { type: "thinking.select", thinkingOptionId: "high" },
      { type: "permissionMode.select", permissionModeId: "allow-all" },
    ] as const) {
      expect(await session.execute(command as never)).toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
    }
    expect(
      (
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("duplicate"),
          input: [{ type: "text", text: "extra" }],
        })
      ).ok,
    ).toBe(false);
    await vi.waitFor(() => expect(client.resolveTurn).toBeDefined());
    f.append("hello");
    client.resolveTurn?.({ stopReason: "end_turn" });
    expect(await finished(stream.outputs)).toMatchObject([
      {
        event: { type: "turn.completed", nativeTurnRef, outcome: { status: "succeeded" } },
      },
    ]);
    expect(client.calls).toContain("model:gpt-5-mini");
    expect(client.calls).toContain("reasoning_effort:high");
    expect(client.calls).toContain("allow_all:off");
    expect((await session.readSnapshot()).ok).toBe(true);
    await session.close();
    await stream.pending;
    await f.adapter.close();
  });

  it("preserves immutable streamed starts and confirms both native Permission Modes", async () => {
    const f = setup();
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const session = opened.value;
    const stream = await collect(session);
    const client = f.clients[0];
    if (!client) throw Error("Missing fake client");
    client.deferred = true;
    const turnId = hostTurnIdSchema.parse("streamed-turn");
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "hello" }] });
    await vi.waitFor(() => expect(client.resolveTurn).toBeDefined());
    for (const text of ["first", " second"]) {
      client.options.onUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      } as never);
    }
    await vi.waitFor(() =>
      expect(
        stream.outputs.filter(
          (entry) => entry.kind === "event" && entry.event.type === "item.updated",
        ),
      ).toHaveLength(2),
    );
    const started = stream.outputs.find(
      (entry) => entry.kind === "event" && entry.event.type === "item.started",
    );
    const completedText = stream.outputs.filter(
      (entry) => entry.kind === "event" && entry.event.type === "item.updated",
    );
    expect(started).toMatchObject({ event: { item: { text: "" } } });
    expect(completedText).toHaveLength(2);
    f.append("hello");
    client.resolveTurn?.({ stopReason: "end_turn" });
    await finished(stream.outputs);
    expect(started).toMatchObject({ event: { item: { text: "" } } });
    expect(stream.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "item.completed",
            snapshot: expect.objectContaining({
              item: expect.objectContaining({ text: "first second" }),
            }),
          }),
        }),
      ]),
    );
    for (const [permissionModeId, native] of [
      ["allow-all", "on"],
      ["supervised", "off"],
    ] as const) {
      expect(
        (
          await session.execute({
            type: "permissionMode.select",
            permissionModeId: permissionModeId as never,
          })
        ).ok,
      ).toBe(true);
      expect(client.calls).toContain(`allow_all:${native}`);
    }
    await session.close();
    await stream.pending;
    await f.adapter.close();
  });

  it("stops before a pending history preflight without ever submitting the prompt", async () => {
    const f = setup();
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const stream = await collect(opened.value);
    let releaseHistory!: () => void;
    f.history.mockImplementationOnce(
      () =>
        new Promise<HostThreadSnapshot>((resolve) => {
          releaseHistory = () => resolve({ turns: [] });
        }),
    );
    const turnId = hostTurnIdSchema.parse("preflight-stop");
    expect(
      (
        await opened.value.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "hello" }],
        })
      ).ok,
    ).toBe(true);
    expect((await opened.value.execute({ type: "turn.cancel", turnId })).ok).toBe(true);
    releaseHistory();
    expect(await finished(stream.outputs)).toMatchObject([
      { event: { type: "turn.completed", outcome: { status: "cancelled" } } },
    ]);
    expect(f.clients[0]?.calls).not.toContain("prompt:hello");
    expect(f.clients[0]?.calls).not.toContain("cancel");
    await opened.value.close();
    await stream.pending;
    await f.adapter.close();
  });

  it("reports native cancellation without requiring a complete history Turn", async () => {
    const f = setup();
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const stream = await collect(opened.value);
    const client = f.clients[0];
    if (!client) throw Error("Missing fake client");
    client.deferred = true;
    const turnId = hostTurnIdSchema.parse("native-cancel-no-history");
    await opened.value.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "hello" }],
    });
    await vi.waitFor(() => expect(client.resolveTurn).toBeDefined());
    expect((await opened.value.execute({ type: "turn.cancel", turnId })).ok).toBe(true);
    expect(await finished(stream.outputs)).toMatchObject([
      { event: { type: "turn.completed", outcome: { status: "cancelled" } } },
    ]);
    expect(f.history).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(false);
    await opened.value.close();
    await stream.pending;
    await f.adapter.close();
  });

  it("keeps the Session after a native prompt settles within the Stop grace", async () => {
    vi.useFakeTimers();
    const f = setup();
    let session: Awaited<ReturnType<typeof f.adapter.open>> | undefined;
    try {
      session = await f.adapter.open({ kind: "create", cwd: process.cwd() });
      if (!session.ok) throw Error(session.error.message);
      const stream = await collect(session.value);
      const client = f.clients[0];
      if (!client) throw Error("Missing fake client");
      client.deferred = true;
      client.settleOnCancel = false;
      const turnId = hostTurnIdSchema.parse("graceful-stop");
      await session.value.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "hello" }],
      });
      await vi.waitFor(() => expect(client.resolveTurn).toBeDefined());
      expect((await session.value.execute({ type: "turn.cancel", turnId })).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(4_000);
      client.resolveTurn?.({ stopReason: "cancelled" });
      expect(await finished(stream.outputs)).toMatchObject([
        { event: { type: "turn.completed", outcome: { status: "cancelled" } } },
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.closed).toBe(false);
      expect(
        stream.outputs.some(
          (entry) => entry.kind === "event" && entry.event.type === "session.faulted",
        ),
      ).toBe(false);
      await session.value.close();
      await stream.pending;
    } finally {
      if (session?.ok) await session.value.close();
      await f.adapter.close();
      vi.useRealTimers();
    }
  });

  it("bounds a cancelled prompt that never acknowledges ACP cancel and rejects late approval", async () => {
    vi.useFakeTimers();
    const f = setup();
    let session: Awaited<ReturnType<typeof f.adapter.open>> | undefined;
    try {
      session = await f.adapter.open({ kind: "create", cwd: process.cwd() });
      if (!session.ok) throw Error(session.error.message);
      const stream = await collect(session.value);
      const client = f.clients[0];
      if (!client) throw Error("Missing fake client");
      client.deferred = true;
      client.settleOnCancel = false;
      const turnId = hostTurnIdSchema.parse("stalled-cancel");
      await session.value.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "hello" }],
      });
      await vi.waitFor(() => expect(client.resolveTurn).toBeDefined());
      expect((await session.value.execute({ type: "turn.cancel", turnId })).ok).toBe(true);
      const late = await client.options.onPermission({
        sessionId,
        toolCall: { toolCallId: "late", title: "Late tool" },
        options: [{ optionId: "no", name: "Deny", kind: "reject_once" }],
      } as never);
      expect(late).toEqual({ outcome: { outcome: "cancelled" } });
      expect(stream.outputs.some((entry) => entry.kind === "interaction")).toBe(false);
      expect(client.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.closed).toBe(true);
      expect(await finished(stream.outputs)).toMatchObject([
        { event: { type: "turn.completed", outcome: { status: "cancelled" } } },
      ]);
      const completedIndex = stream.outputs.findIndex(
        (entry) => entry.kind === "event" && entry.event.type === "turn.completed",
      );
      const faultIndex = stream.outputs.findIndex(
        (entry) => entry.kind === "event" && entry.event.type === "session.faulted",
      );
      expect(faultIndex).toBeGreaterThan(completedIndex);
      expect(
        (
          await session.value.execute({
            type: "thinking.select",
            thinkingOptionId: "high" as never,
          })
        ).ok,
      ).toBe(false);
      await session.value.close();
      await stream.pending;
    } finally {
      if (session?.ok) await session.value.close();
      await f.adapter.close();
      vi.useRealTimers();
    }
  });

  it("does not call a failed cancel a successful native cancellation", async () => {
    const f = setup();
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const stream = await collect(opened.value);
    const client = f.clients[0];
    if (!client) throw Error("Missing fake client");
    client.deferred = true;
    client.cancel = async () => {
      throw Error("notification write failed");
    };
    const turnId = hostTurnIdSchema.parse("failed-cancel");
    await opened.value.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "hello" }],
    });
    await vi.waitFor(() => expect(client.resolveTurn).toBeDefined());
    expect((await opened.value.execute({ type: "turn.cancel", turnId })).ok).toBe(false);
    f.append("hello");
    client.resolveTurn?.({ stopReason: "end_turn" });
    expect(await finished(stream.outputs)).toMatchObject([
      { event: { type: "turn.completed", outcome: { status: "succeeded" } } },
    ]);
    await opened.value.close();
    await stream.pending;
    await f.adapter.close();
  });

  it("streams tool progress and closes an approved native permission", async () => {
    const f = setup();
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const session = opened.value;
    const stream = await collect(session);
    const client = f.clients[0];
    if (!client) throw Error("Missing fake client");
    client.deferred = true;
    const turnId = hostTurnIdSchema.parse("approved-tool");
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "hello" }] });
    client.options.onUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "native-tool",
        title: "Read file",
        rawInput: { path: "file.txt" },
        status: "in_progress",
      },
    } as never);
    client.options.onUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "native-tool",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "done" } }],
      },
    } as never);
    const pending = client.options.onPermission({
      sessionId,
      toolCall: { toolCallId: "native-tool", title: "Read file" },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Deny", kind: "reject_once" },
      ],
    } as never);
    await vi.waitFor(() =>
      expect(stream.outputs.some((output) => output.kind === "interaction")).toBe(true),
    );
    const emitted = stream.outputs.find((output) => output.kind === "interaction");
    if (emitted?.kind !== "interaction") throw Error("Missing approval");
    expect(
      (
        await session.execute({
          type: "interaction.respond",
          interactionId: emitted.interaction.interactionId,
          response: { type: "approval", actionId: "yes" },
        })
      ).ok,
    ).toBe(true);
    expect(await pending).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    expect(stream.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "interaction.closed",
            reason: "responded",
            turnId,
          }),
        }),
      ]),
    );
    f.append("hello");
    client.resolveTurn?.({ stopReason: "end_turn" });
    await finished(stream.outputs);
    expect(stream.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "item.completed",
            snapshot: {
              item: expect.objectContaining({
                type: "toolExecution",
                arguments: { path: "file.txt" },
                output: { content: [{ type: "text", text: "done" }] },
              }),
              outcome: { status: "succeeded" },
            },
          }),
        }),
      ]),
    );
    await session.close();
    await stream.pending;
    await f.adapter.close();
  });
  it("shows native approvals and cancels pending requests on Turn cancellation", async () => {
    const f = setup();
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const session = opened.value,
      stream = await collect(session),
      client = f.clients[0];
    if (!client) throw Error("Missing fake client");
    client.deferred = true;
    const turnId = hostTurnIdSchema.parse("approval-turn");
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "hello" }] });
    const permission = client.options.onPermission({
      sessionId,
      toolCall: { toolCallId: "call", title: "Run tool" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    } as never);
    await vi.waitFor(() =>
      expect(stream.outputs.some((output) => output.kind === "interaction")).toBe(true),
    );
    const interaction = stream.outputs.find((output) => output.kind === "interaction");
    if (interaction?.kind !== "interaction") throw Error("Missing approval");
    expect(
      (
        await session.execute({
          type: "interaction.respond",
          interactionId: interaction.interaction.interactionId,
          response: { type: "approval", actionId: "wrong" },
        })
      ).ok,
    ).toBe(false);
    expect((await session.execute({ type: "turn.cancel", turnId })).ok).toBe(true);
    expect(await permission).toEqual({
      outcome: { outcome: "cancelled" } satisfies RequestPermissionResponse["outcome"],
    });
    expect(client.calls).toContain("cancel");
    await finished(stream.outputs);
    await session.close();
    await stream.pending;
    await f.adapter.close();
  });
});
