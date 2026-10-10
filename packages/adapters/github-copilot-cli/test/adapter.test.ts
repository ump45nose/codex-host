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
  resolveTurn?: (value: Record<string, unknown>) => void;
  closed = false;
  configuration = structuredClone(info.configOptions);
  constructor(options: CopilotClientOptions) {
    this.options = options;
  }
  async initialize() {
    return { agentCapabilities: { loadSession: true } };
  }
  async open(_cwd: string, session?: string) {
    return {
      ...info,
      configOptions: this.configuration,
      ...(session ? { sessionId: session } : {}),
    };
  }
  async prompt(_session: string, text: string) {
    this.calls.push(`prompt:${text}`);
    if (!this.deferred) return { stopReason: "end_turn" };
    return new Promise<Record<string, unknown>>((resolve) => {
      this.resolveTurn = resolve;
    });
  }
  async cancel() {
    this.calls.push("cancel");
    this.resolveTurn?.({ stopReason: "cancelled" });
  }
  async setConfigOption(_session: string, key: string, value: string) {
    this.calls.push(`${key}:${value}`);
    this.configuration = this.configuration.map((option) =>
      option.id === key ? { ...option, currentValue: value } : option,
    );
    return { configOptions: this.configuration };
  }
  async close() {
    this.closed = true;
    this.resolveTurn?.({ stopReason: "cancelled" });
  }
}
function requiredClient(clients: FakeClient[], index = 0): FakeClient {
  const client = clients[index];
  if (!client) throw new Error("Missing fake Copilot client");
  return client;
}
function setup(cancellationTimeoutMs = 5_000) {
  const clients: FakeClient[] = [];
  const turns: HostThreadSnapshot["turns"] = [];
  const history = vi.fn(async (): Promise<HostThreadSnapshot> => ({
    turns: structuredClone(turns),
  }));
  const adapter = new GitHubCopilotAdapter({
    cancellationTimeoutMs,
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
      expect(opened.value.initialState.nativeRef).toMatchObject(ref);
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
  it("does not send a prompt cancelled while native history is being read", async () => {
    const f = setup();
    let release!: (snapshot: HostThreadSnapshot) => void;
    f.history.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const stream = await collect(opened.value);
    const turnId = hostTurnIdSchema.parse("early-cancel");
    await opened.value.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "cancel me" }],
    });
    await opened.value.execute({ type: "turn.cancel", turnId });
    expect(await finished(stream.outputs)).toMatchObject([
      { event: { outcome: { status: "cancelled" } } },
    ]);
    release({ turns: [] });
    expect(requiredClient(f.clients).calls).not.toContain("prompt:cancel me");
    expect(requiredClient(f.clients).calls).not.toContain("cancel");
    await f.adapter.close();
    await stream.pending;
  });

  it("reaps a native prompt that ignores cancellation and resumes for the next turn", async () => {
    const f = setup(10);
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const stream = await collect(opened.value);
    const client = requiredClient(f.clients);
    client.prompt = vi.fn(async () => new Promise<Record<string, unknown>>(() => {}));
    client.cancel = vi.fn(async () => {});
    client.close = vi.fn(async () => {
      client.closed = true;
    });
    const turnId = hostTurnIdSchema.parse("stuck-cancel");
    await opened.value.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "stuck" }],
    });
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalled());
    await opened.value.execute({ type: "turn.cancel", turnId });
    expect(await finished(stream.outputs)).toMatchObject([
      { event: { outcome: { status: "cancelled" } } },
    ]);
    expect(client.closed).toBe(true);
    await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("after-cancel"),
      input: [{ type: "text", text: "continue" }],
    });
    await finished(stream.outputs, 2);
    expect(f.clients).toHaveLength(2);
    expect(requiredClient(f.clients, 1).calls).toContain("prompt:continue");
    await f.adapter.close();
    await stream.pending;
  });

  it("restores the same native identity when switching context and persists the tier", async () => {
    const f = setup();
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const stream = await collect(opened.value);
    const client = requiredClient(f.clients);
    client.deferred = true;
    await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("before-context"),
      input: [{ type: "text", text: "hello" }],
    });
    await vi.waitFor(() => expect(client.resolveTurn).toBeDefined());
    f.append("hello");
    client.resolveTurn?.({ stopReason: "end_turn" });
    await finished(stream.outputs);
    const result = await opened.value.execute({
      type: "model.select",
      model: copilotModelRef("gpt-5-mini", "long_context"),
    });
    expect(result.ok).toBe(true);
    expect(requiredClient(f.clients).closed).toBe(true);
    expect(requiredClient(f.clients, 1).options.contextTier).toBe("long_context");
    expect(await opened.value.readSnapshot()).toMatchObject({
      ok: true,
      value: {
        state: {
          effectiveModel: copilotModelRef("gpt-5-mini", "long_context"),
          nativeRef: { nativeSessionId: sessionId, locator: { contextTier: "long_context" } },
        },
      },
    });
    await f.adapter.close();
    await stream.pending;
  });

  it("refreshes thinking capabilities after switching away from a model without reasoning", async () => {
    const f = setup();
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const stream = await collect(opened.value);
    requiredClient(f.clients).options.onUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: info.configOptions.slice(0, 1),
      },
    } as never);
    expect(opened.value.capabilities.configuration.selectThinkingOption).toBe(false);
    expect(
      (await opened.value.execute({ type: "model.select", model: copilotModelRef("gpt-5-mini") }))
        .ok,
    ).toBe(true);
    expect(opened.value.capabilities.configuration.selectThinkingOption).toBe(true);
    expect(
      (await opened.value.execute({ type: "thinking.select", thinkingOptionId: "high" as never }))
        .ok,
    ).toBe(true);
    await f.adapter.close();
    await stream.pending;
  });

  it("keeps started text immutable even when notifications arrive before consumption", async () => {
    const f = setup();
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    const client = requiredClient(f.clients);
    client.deferred = true;
    const turnId = hostTurnIdSchema.parse("text-snapshot");
    await opened.value.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "hello" }],
    });
    await vi.waitFor(() => expect(client.resolveTurn).toBeDefined());
    for (const text of ["one", "two"])
      client.options.onUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      } as never);
    f.append("hello");
    client.resolveTurn?.({ stopReason: "end_turn" });
    const stream = await collect(opened.value);
    await finished(stream.outputs);
    expect(
      stream.outputs.find((o) => o.kind === "event" && o.event.type === "item.started"),
    ).toMatchObject({ event: { item: { text: "" } } });
    expect(
      stream.outputs.find((o) => o.kind === "event" && o.event.type === "item.completed"),
    ).toMatchObject({ event: { snapshot: { item: { text: "onetwo" } } } });
    await f.adapter.close();
    await stream.pending;
  });
  it("recreates an unpersisted context without publishing a stale native identity", async () => {
    const f = setup();
    const opened = await f.adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw Error(opened.error.message);
    expect(opened.value.initialState.nativeRef).toBeUndefined();
    expect(
      (
        await opened.value.execute({
          type: "model.select",
          model: copilotModelRef("gpt-5-mini", "long_context"),
        })
      ).ok,
    ).toBe(true);
    expect(await opened.value.readSnapshot()).toMatchObject({
      ok: true,
      value: { state: { effectiveModel: copilotModelRef("gpt-5-mini", "long_context") } },
    });
    await f.adapter.close();
  });
});
