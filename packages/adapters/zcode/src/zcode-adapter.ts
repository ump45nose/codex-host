import { randomUUID } from "node:crypto";

import {
  HarnessOutputChannel,
  type HarnessAdapter,
  type HarnessError,
  type HarnessInspection,
  type HostCommand,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostItemOutcome,
  type HostReasoningItem,
  type HostThreadSnapshot,
  type InspectHarnessInput,
  type OpenSessionInput,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnStartAccepted,
  type TurnStartCommand,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
} from "@codexhost/shared-contracts";

import { ZCodeAppServer, ZCodeAppServerError } from "./app-server.js";
import {
  decodeZCodeModelRef,
  decodeZCodeThinkingOption,
  encodeZCodeModelRef,
  encodeZCodeThinkingOption,
  zcodeModelCatalog,
} from "./model-catalog.js";

const zcodeHarnessId = harnessIdSchema.parse("zcode");

const capabilities: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: false,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
};

interface ZCodeSnapshot {
  messages?: unknown[];
  runtime?: { stateRevision?: unknown };
  session?: {
    sessionId?: unknown;
    model?: unknown;
    workspace?: unknown;
  };
  settings?: {
    model?: { current?: unknown };
    thoughtLevel?: { available?: unknown; current?: unknown };
  };
}

interface ActiveTurn {
  command: TurnStartCommand;
  nativeTurnId?: string;
  agent: HostAgentMessageItem | null;
  reasoning: HostReasoningItem | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizedError(error: unknown): HarnessError {
  if (error instanceof ZCodeAppServerError) {
    return {
      code:
        error.kind === "notInstalled"
          ? "notInstalled"
          : error.kind === "protocol"
            ? "protocolError"
            : "processExited",
      message: error.message,
      retryable: error.kind !== "notInstalled",
    };
  }
  return {
    code: "internalError",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function stateFromSnapshot(snapshot: ZCodeSnapshot): HarnessSessionState {
  const sessionId = String(snapshot.session?.sessionId ?? "");
  const currentModel = object(snapshot.settings?.model?.current ?? snapshot.session?.model);
  const thought = snapshot.settings?.thoughtLevel;
  const available = Array.isArray(thought?.available)
    ? thought.available.flatMap((entry) => {
        const candidate = object(entry);
        const value = typeof candidate?.value === "string" ? candidate.value : null;
        return value
          ? [{ id: encodeZCodeThinkingOption(value), label: String(candidate?.label ?? value) }]
          : [];
      })
    : [];
  return {
    nativeRef: nativeSessionRefSchema.parse({
      harnessId: zcodeHarnessId,
      nativeSessionId: sessionId,
      locator: snapshot.session?.workspace ?? {},
      formatVersion: 1,
    }),
    ...(typeof currentModel?.providerId === "string" && typeof currentModel.modelId === "string"
      ? {
          effectiveModel: encodeZCodeModelRef({
            providerId: currentModel.providerId,
            modelId: currentModel.modelId,
          }),
          resolvedModelLabel: currentModel.modelId,
        }
      : {}),
    ...(available.length > 0 ? { availableThinkingOptions: available } : {}),
    ...(typeof thought?.current === "string"
      ? { effectiveThinkingOptionId: encodeZCodeThinkingOption(thought.current) }
      : {}),
  };
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .flatMap((part) => {
      const candidate = object(part);
      return candidate?.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("");
}

/** Projects persisted ZCode user/assistant messages into resumable Host turns. */
export function projectZCodeSnapshot(snapshot: ZCodeSnapshot): HostThreadSnapshot {
  const sessionId = String(snapshot.session?.sessionId ?? "");
  const turns: HostThreadSnapshot["turns"] = [];
  let pending: { id: string; text: string; startedAt?: number } | null = null;
  for (const rawMessage of snapshot.messages ?? []) {
    const message = object(rawMessage);
    const info = object(message?.info);
    const role = info?.role;
    const id = typeof info?.messageId === "string" ? info.messageId : randomUUID();
    if (role === "user") {
      pending = {
        id,
        text: textFromParts(message?.parts),
        ...(typeof object(info?.time)?.created === "number"
          ? { startedAt: object(info?.time)?.created as number }
          : {}),
      };
      continue;
    }
    if (role !== "assistant" || !pending) continue;
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    const items = parts.flatMap((part, index) => {
      const candidate = object(part);
      if (
        (candidate?.type !== "text" && candidate?.type !== "reasoning") ||
        typeof candidate.text !== "string" ||
        candidate.text.length === 0
      ) {
        return [];
      }
      return [
        {
          item: {
            type:
              candidate.type === "reasoning" ? ("reasoning" as const) : ("agentMessage" as const),
            itemId: hostItemIdSchema.parse(`zcode-${id}-${index}`),
            text: candidate.text,
          },
          outcome: { status: "succeeded" as const },
        },
      ];
    });
    const completed = object(info?.time)?.completed;
    turns.push({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: zcodeHarnessId,
        nativeSessionId: sessionId,
        nativeTurnKey: pending.id,
        formatVersion: 1,
      }),
      input: [{ type: "text", text: pending.text }],
      items,
      outcome: { status: "succeeded" },
      ...(pending.startedAt ? { startedAtMs: pending.startedAt } : {}),
      ...(typeof completed === "number" ? { completedAtMs: completed } : {}),
    });
    pending = null;
  }
  return { turns, state: stateFromSnapshot(snapshot) };
}

class ZCodeHarnessSession implements HarnessSession {
  readonly harnessId: HarnessId = zcodeHarnessId;
  readonly capabilities = capabilities;
  readonly initialUsage = null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  initialState: HarnessSessionState;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #server: ZCodeAppServer;
  readonly #sessionId: string;
  #revision: number;
  #active: ActiveTurn | null = null;
  #closed = false;

  constructor(server: ZCodeAppServer, snapshot: ZCodeSnapshot) {
    this.#server = server;
    this.#sessionId = String(snapshot.session?.sessionId ?? "");
    this.#revision = Number(snapshot.runtime?.stateRevision ?? 0);
    this.initialState = stateFromSnapshot(snapshot);
    this.outputs = this.#channel.outputs;
    server.onNotification((message) => this.#onNotification(message));
  }

  /** Reads the authoritative native session snapshot and projects its history. */
  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    try {
      const snapshot = await this.#server.request<ZCodeSnapshot>("session/read", {
        sessionId: this.#sessionId,
      });
      this.initialState = stateFromSnapshot(snapshot);
      return { ok: true, value: projectZCodeSnapshot(snapshot) };
    } catch (error) {
      return { ok: false, error: normalizedError(error) };
    }
  }

  /** Starts a native ZCode turn; streamed output arrives through session/event notifications. */
  async execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  async execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  async execute(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>>;
  async execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  async execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  async execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#closed) {
      return {
        ok: false,
        error: { code: "invalidState", message: "ZCode Session is closed", retryable: false },
      };
    }
    try {
      if (command.type === "turn.start") {
        if (this.#active) {
          return {
            ok: false,
            error: { code: "sessionBusy", message: "ZCode Session is busy", retryable: true },
          };
        }
        this.#active = { command, agent: null, reasoning: null };
        this.#event({ type: "turn.started", turnId: command.turnId });
        const result = await this.#server.request<{ stateRevision: number }>("session/send", {
          sessionId: this.#sessionId,
          inputId: randomUUID(),
          content: command.input.map(({ text }) => text).join("\n"),
          expectedRevision: this.#revision,
        });
        this.#revision = result.stateRevision;
        return { ok: true, value: { turnId: command.turnId } };
      }
      if (command.type === "turn.cancel") {
        await this.#server.request("session/stop", { sessionId: this.#sessionId });
        return { ok: true, value: { cancellationRequested: true } };
      }
      if (command.type === "model.select") {
        await this.#server.request("session/setModel", {
          sessionId: this.#sessionId,
          model: decodeZCodeModelRef(command.model),
          expectedRevision: this.#revision,
        });
        this.initialState = { ...this.initialState, effectiveModel: command.model };
        this.#event({ type: "session.state.changed", state: this.initialState });
        return { ok: true, value: { completed: true } };
      }
      if (command.type === "thinking.select") {
        await this.#server.request("session/setThoughtLevel", {
          sessionId: this.#sessionId,
          thoughtLevel: decodeZCodeThinkingOption(command.thinkingOptionId),
          expectedRevision: this.#revision,
        });
        this.initialState = {
          ...this.initialState,
          effectiveThinkingOptionId: command.thinkingOptionId,
        };
        this.#event({ type: "session.state.changed", state: this.initialState });
        return { ok: true, value: { completed: true } };
      }
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: `${command.type} is not supported by ZCode`,
          retryable: false,
        },
      };
    } catch (error) {
      return { ok: false, error: normalizedError(error) };
    }
  }

  /** Closes the native session handle and its dedicated app-server process. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#server
      .request("session/close", { sessionId: this.#sessionId })
      .catch(() => undefined);
    await this.#server.close();
    this.#channel.end();
  }

  #event(event: Extract<HarnessOutput, { kind: "event" }>["event"]): void {
    this.#channel.emit({ kind: "event", event });
  }

  #onNotification(message: Record<string, unknown>): void {
    if (message.method !== "session/event") return;
    const params = object(message.params);
    if (params?.sessionId !== this.#sessionId || !this.#active) return;
    const active = this.#active;
    const payload = object(params.payload);
    if (params.type === "turn.started" && typeof params.turnId === "string") {
      active.nativeTurnId = params.turnId;
      return;
    }
    if (params.type === "model.streaming") {
      const delta = typeof payload?.delta === "string" ? payload.delta : "";
      if (!delta) return;
      const reasoning = payload?.kind === "reasoning_delta";
      const item = reasoning ? active.reasoning : active.agent;
      if (!item) {
        const created = {
          type: reasoning ? ("reasoning" as const) : ("agentMessage" as const),
          itemId: hostItemIdSchema.parse(`zcode-live-${randomUUID()}`),
          text: "",
        };
        if (reasoning) active.reasoning = created as HostReasoningItem;
        else active.agent = created as HostAgentMessageItem;
        this.#event({ type: "item.started", turnId: active.command.turnId, item: created });
      }
      const current = reasoning ? active.reasoning : active.agent;
      if (!current) return;
      current.text += delta;
      this.#event({
        type: "item.updated",
        turnId: active.command.turnId,
        itemId: current.itemId,
        update: { type: "text.append", text: delta },
      });
      return;
    }
    if (params.type !== "turn.completed") return;
    const outcome: HostItemOutcome = { status: "succeeded" };
    for (const item of [active.reasoning, active.agent]) {
      if (item)
        this.#event({
          type: "item.completed",
          turnId: active.command.turnId,
          snapshot: { item, outcome },
        });
    }
    this.#event({
      type: "turn.completed",
      turnId: active.command.turnId,
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: zcodeHarnessId,
        nativeSessionId: this.#sessionId,
        nativeTurnKey: active.nativeTurnId ?? String(payload?.inputId ?? randomUUID()),
        formatVersion: 1,
      }),
      outcome: { status: "succeeded" },
    });
    this.#active = null;
  }
}

export interface ZCodeAdapterOptions {
  command?: string;
  environment?: Record<string, string | undefined>;
}

/** Native ZCode Harness plugin, following the same adapter boundary as Pi and DSH. */
export class ZCodeAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = zcodeHarnessId;
  readonly #options: ZCodeAdapterOptions;
  readonly #sessions = new Set<ZCodeHarnessSession>();

  constructor(options: ZCodeAdapterOptions = {}) {
    this.#options = options;
  }

  /** Starts a short-lived native process to obtain ZCode's actual model catalog. */
  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    const server = this.#server(input.cwd ?? process.cwd());
    try {
      const snapshot = await server.request<ZCodeSnapshot>("session/create", {
        workspace: {
          workspacePath: input.cwd ?? process.cwd(),
          workspaceKey: input.cwd ?? process.cwd(),
        },
        persistence: "deferred",
        titleGenerationEnabled: false,
      });
      const catalog = zcodeModelCatalog(snapshot);
      const sessionId = String(snapshot.session?.sessionId ?? "");
      await server.request("session/close", { sessionId, expectedPersistence: "deferred" });
      return { status: "ready", catalog, capabilities };
    } catch (error) {
      const normalized = normalizedError(error);
      return {
        status: normalized.code === "notInstalled" ? "notInstalled" : "error",
        error: { ...normalized, ...(server.stderrTail ? { stderrTail: server.stderrTail } : {}) },
      };
    } finally {
      await server.close();
    }
  }

  /** Creates or resumes a native ZCode session without modifying Codex account configuration. */
  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "ZCode history derivation is not enabled",
          retryable: false,
        },
      };
    }
    const server = this.#server(input.cwd, input.environment);
    try {
      let snapshot: ZCodeSnapshot;
      if (input.kind === "resume") {
        if (input.nativeRef.harnessId !== this.harnessId)
          throw new Error("Invalid ZCode Session reference");
        snapshot = await server.request<ZCodeSnapshot>("session/resume", {
          sessionId: input.nativeRef.nativeSessionId,
          workspace: { workspacePath: input.cwd, workspaceKey: input.cwd },
        });
      } else {
        snapshot = await server.request<ZCodeSnapshot>("session/create", {
          workspace: { workspacePath: input.cwd, workspaceKey: input.cwd },
          ...(input.model ? { model: decodeZCodeModelRef(input.model) } : {}),
          ...(input.thinkingOptionId
            ? { thoughtLevel: decodeZCodeThinkingOption(input.thinkingOptionId) }
            : {}),
        });
      }
      const sessionId = String(snapshot.session?.sessionId ?? "");
      await server.request("session/subscribe", {
        sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
      });
      const session = new ZCodeHarnessSession(server, snapshot);
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (error) {
      await server.close();
      return { ok: false, error: normalizedError(error) };
    }
  }

  /** Releases every native process owned by this plugin instance. */
  async close(): Promise<void> {
    await Promise.all([...this.#sessions].map((session) => session.close()));
    this.#sessions.clear();
  }

  #server(cwd: string, environment?: Record<string, string | undefined>): ZCodeAppServer {
    return new ZCodeAppServer({
      cwd,
      ...(this.#options.command ? { command: this.#options.command } : {}),
      environment: { ...this.#options.environment, ...environment },
    });
  }
}
