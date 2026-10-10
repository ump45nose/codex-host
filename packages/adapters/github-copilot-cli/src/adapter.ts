import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  HarnessOutputChannel,
  sanitizeDiagnosticTail,
  validateHostApprovalResponse,
  type HarnessAdapter,
  type HarnessError,
  type HarnessErrorCode,
  type HarnessInspection,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostCommand,
  type HostItem,
  type HostItemSnapshot,
  type HostThreadSnapshot,
  type InspectHarnessInput,
  type OpenSessionInput,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessInspectionSchema,
  hostInteractionIdSchema,
  hostItemIdSchema,
  jsonValueSchema,
  nativeSessionRefSchema,
  type HostTurnId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import { CopilotAcpClient, type CopilotClient, type CopilotClientOptions } from "./acp-client.js";
import { restoreCopilotClient } from "./client-restoration.js";
import { inspectCopilotCatalog } from "./catalog.js";
import { readCopilotHistory } from "./native-history.js";
import {
  COPILOT_PERMISSION_MODES,
  copilotConfiguration,
  copilotNativeModel,
  copilotNativeContext,
  type CopilotContextTier,
} from "./configuration.js";

const ID = harnessIdSchema.parse("github-copilot-cli");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function errorOf(error: unknown, code?: HarnessErrorCode): HarnessError {
  const message = sanitizeDiagnosticTail(error instanceof Error ? error.message : String(error));
  return {
    code:
      code ??
      (/not installed/iu.test(message)
        ? "notInstalled"
        : /unauthenticated|not logged in|authentication required|login required/iu.test(message)
          ? "authenticationRequired"
          : "nativeFailure"),
    message: `GitHub Copilot CLI: ${message || "native operation failed"}`,
    retryable: false,
  };
}
const failure = <T>(code: HarnessErrorCode, message: string): HarnessResult<T> => ({
  ok: false,
  error: errorOf(message, code),
});

export interface GitHubCopilotAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  command?: string;
  clientFactory?: (options: CopilotClientOptions) => CopilotClient;
  readHistory?: typeof readCopilotHistory;
  cancellationTimeoutMs?: number;
}

export class GitHubCopilotAdapter implements HarnessAdapter {
  readonly harnessId = ID;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #factory: (options: CopilotClientOptions) => CopilotClient;
  readonly #history: typeof readCopilotHistory;
  readonly #sessions = new Set<CopilotSession>();
  #closed = false;

  constructor(readonly options: GitHubCopilotAdapterOptions = {}) {
    this.#environment = { ...(options.environment ?? process.env) };
    this.#factory = options.clientFactory ?? ((input) => new CopilotAcpClient(input));
    this.#history = options.readHistory ?? readCopilotHistory;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    let client: CopilotClient | undefined;
    try {
      if (this.#closed) throw new Error("Adapter is closed");
      const cwd = input.cwd ?? process.cwd();
      if (!(await stat(cwd)).isDirectory()) throw new Error("Working directory is not a directory");
      client = this.#factory({
        cwd,
        environment: this.#environment,
        contextTier: "default",
        ...(this.options.command ? { command: this.options.command } : {}),
        onUpdate: () => {},
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onFault: () => {},
      });
      await client.initialize();
      const opened = await client.open(cwd);
      const config = await inspectCopilotCatalog(client, opened);
      return harnessInspectionSchema.parse({
        status: "ready",
        catalog: config.catalog,
        capabilities: config.capabilities,
        ...(config.capabilities.configuration.selectPermissionMode
          ? { permissionModes: COPILOT_PERMISSION_MODES }
          : {}),
      });
    } catch (error) {
      const issue = errorOf(error);
      return {
        status: issue.code === "notInstalled" ? "notInstalled" : "unavailable",
        error: issue,
      };
    } finally {
      await client?.close().catch(() => {});
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return failure("invalidState", "Adapter is closed");
    if (input.kind === "fork" || input.kind === "rollbackLastTurn")
      return failure("unsupported", "Copilot ACP does not expose this history operation");
    if (input.kind === "create" && input.executionPolicy === "unattended-full-access")
      return failure("unsupported", "Copilot ACP has no verified unattended approval policy");
    if (
      input.kind === "resume" &&
      (input.nativeRef.harnessId !== ID || input.nativeRef.formatVersion !== 1)
    )
      return failure(
        "invalidRequest",
        "Native Session reference is not a supported Copilot reference",
      );
    let session: CopilotSession | undefined;
    try {
      if (!(await stat(input.cwd)).isDirectory())
        throw new Error("Working directory is not a directory");
      if (input.kind === "resume") {
        const originalCwd = record(input.nativeRef.locator).cwd;
        if (
          typeof originalCwd !== "string" ||
          !path.isAbsolute(originalCwd) ||
          (await realpath(input.cwd)) !== (await realpath(originalCwd))
        )
          return failure("invalidRequest", "Copilot Session workspace does not match");
      }
      session = new CopilotSession(
        input,
        { ...this.#environment, ...input.environment },
        this.#factory,
        this.#history,
        this.options.command,
        this.options.cancellationTimeoutMs ?? 5_000,
        () => {
          if (session) this.#sessions.delete(session);
        },
      );
      this.#sessions.add(session);
      await session.initialize();
      return { ok: true, value: session };
    } catch (error) {
      await session?.close().catch(() => {});
      return { ok: false, error: errorOf(error) };
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const closed = await Promise.allSettled([...this.#sessions].map((session) => session.close()));
    this.#sessions.clear();
    const errors = closed.filter((result) => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors, "Copilot Sessions did not close cleanly");
  }
}

type SessionInput = Extract<OpenSessionInput, { kind: "create" | "resume" }>;
type PendingPermission = {
  id: ReturnType<typeof hostInteractionIdSchema.parse>;
  turnId: HostTurnId;
  interaction: Extract<HarnessOutput, { kind: "interaction" }>["interaction"] & {
    type: "approval";
  };
  resolve(response: RequestPermissionResponse): void;
};
type ActiveTurn = {
  turnId: HostTurnId;
  cancelled: boolean;
  promptStarted: boolean;
  abort: AbortController;
  cancellationTimer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  finish(): void;
  items: Map<string, HostItemSnapshot>;
};

class CopilotSession implements HarnessSession {
  readonly harnessId = ID;
  capabilities: HarnessSessionCapabilities = {
    configuration: {
      selectModel: true,
      selectThinkingOption: false,
      selectPermissionMode: false,
      permissionModeScope: "live",
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  };
  readonly initialUsage = null;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  initialState: HarnessSessionState = {};
  #client: CopilotClient;
  #contextTier: CopilotContextTier;
  #clientResetRequired = false;
  #ref: NativeSessionRef | undefined;
  #state: HarnessSessionState = {};
  #active: ActiveTurn | undefined;
  #permission: PendingPermission | undefined;
  #closed = false;
  #fault: HarnessError | undefined;
  #catalog: ReturnType<typeof copilotConfiguration>["catalog"] | undefined;
  #configuring = false;
  #newSession = false;

  constructor(
    readonly input: SessionInput,
    readonly environment: NodeJS.ProcessEnv,
    readonly factory: (options: CopilotClientOptions) => CopilotClient,
    readonly history: typeof readCopilotHistory,
    readonly command: string | undefined,
    readonly cancellationTimeoutMs: number,
    readonly onClose: () => void,
  ) {
    this.#contextTier =
      input.kind === "resume"
        ? record(input.nativeRef.locator).contextTier === "long_context"
          ? "long_context"
          : "default"
        : input.model
          ? copilotNativeContext(input.model.id)
          : "default";
    this.#client = this.#createClient(this.#contextTier);
  }

  #createClient(contextTier: CopilotContextTier): CopilotClient {
    const client = this.factory({
      cwd: this.input.cwd,
      environment: this.environment,
      contextTier,
      ...(this.command ? { command: this.command } : {}),
      onUpdate: (notification) => {
        if (client === this.#client) this.#update(notification);
      },
      onPermission: (request) =>
        client === this.#client
          ? this.#requestPermission(request)
          : Promise.resolve({ outcome: { outcome: "cancelled" } }),
      onFault: (error) => {
        if (client !== this.#client || this.#closed || this.#clientResetRequired) return;
        this.#fault = errorOf(error, "processExited");
        this.#channel.emit({
          kind: "event",
          event: { type: "session.faulted", error: this.#fault },
        });
      },
    });
    return client;
  }

  async initialize() {
    await this.#client.initialize();
    const sessionId =
      this.input.kind === "resume" ? this.input.nativeRef.nativeSessionId : undefined;
    const opened = await this.#client.open(this.input.cwd, sessionId);
    // ACP session/load may omit sessionId; only the validated requested identity is authoritative.
    const id = str(opened.sessionId) || sessionId;
    if (!id || (sessionId && id !== sessionId))
      throw new Error("Copilot ACP returned a different Session ID");
    this.#ref = nativeSessionRefSchema.parse({
      harnessId: ID,
      nativeSessionId: id,
      formatVersion: 1,
      locator: { cwd: this.input.cwd, contextTier: this.#contextTier },
    });
    const config = copilotConfiguration(opened, this.#contextTier);
    this.capabilities = config.capabilities;
    this.#catalog = config.catalog;
    this.#newSession = this.input.kind === "create";
    this.#state = { ...(!this.#newSession ? { nativeRef: this.#ref } : {}), ...config.state };
    if (this.input.kind === "resume") {
      const snapshot = await this.readSnapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      if (
        this.input.knownTurnRefs?.some(
          (known) =>
            known.harnessId !== ID ||
            known.nativeSessionId !== id ||
            !snapshot.value.turns.some(
              (turn) => turn.nativeTurnRef.nativeTurnKey === known.nativeTurnKey,
            ),
        )
      )
        throw new Error("Saved Copilot Turn identity no longer exists in native history");
    } else {
      if (this.input.model) await this.#selectModel(this.input.model.id);
      if (this.input.thinkingOptionId) await this.#selectThinking(this.input.thinkingOptionId);
      if (this.input.permissionModeId)
        await this.#selectPermissionMode(this.input.permissionModeId);
    }
    this.initialState = this.#state;
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (!this.#ref) return failure("invalidState", "Session is not open");
    if (this.#active || this.#configuring) return failure("sessionBusy", "Copilot Session is busy");
    try {
      const snapshot = await this.history(this.#ref, this.environment);
      this.#newSession = false;
      return { ok: true, value: { ...snapshot, state: this.#state } };
    } catch (error) {
      if (this.#newSession && (error as NodeJS.ErrnoException).code === "ENOENT")
        return { ok: true, value: { turns: [], state: this.#state } };
      return { ok: false, error: errorOf(error, "protocolError") };
    }
  }

  #emit(event: HarnessOutput) {
    this.#channel.emit(structuredClone(event));
  }

  #update(notification: SessionNotification) {
    if (this.#closed || !this.#ref || notification.sessionId !== this.#ref.nativeSessionId) return;
    const update = record(notification.update);
    const kind = update.sessionUpdate;
    if (kind === "config_option_update" && Array.isArray(update.configOptions)) {
      try {
        const config = copilotConfiguration(
          { configOptions: update.configOptions },
          this.#contextTier,
        );
        this.capabilities = config.capabilities;
        this.#catalog = config.catalog;
        this.#state = { ...(!this.#newSession ? { nativeRef: this.#ref } : {}), ...config.state };
        this.#emit({ kind: "event", event: { type: "session.state.changed", state: this.#state } });
      } catch {
        /* Ignore incomplete notifications; command responses remain authoritative. */
      }
      return;
    }
    const active = this.#active;
    if (!active) return;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const content = record(update.content);
      const text = str(content.text);
      if (!text) return;
      const type = kind === "agent_message_chunk" ? "agentMessage" : "reasoning";
      const key = `${type}-${str(update.messageId) || "current"}`;
      let snapshot = active.items.get(key);
      if (!snapshot) {
        const item: HostItem = {
          type,
          itemId: hostItemIdSchema.parse(`copilot-${randomUUID()}`),
          text: "",
        };
        snapshot = { item, outcome: { status: "succeeded" } };
        active.items.set(key, snapshot);
        this.#emit({ kind: "event", event: { type: "item.started", turnId: active.turnId, item } });
      }
      if (snapshot.item.type === "agentMessage" || snapshot.item.type === "reasoning") {
        snapshot.item.text += text;
        this.#emit({
          kind: "event",
          event: {
            type: "item.updated",
            turnId: active.turnId,
            itemId: snapshot.item.itemId,
            update: { type: "text.append", text },
          },
        });
      }
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const call = record(update);
      const key = `tool-${str(call.toolCallId)}`;
      if (!str(call.toolCallId)) return;
      let snapshot = active.items.get(key);
      if (!snapshot) {
        const item: HostItem = {
          type: "toolExecution",
          itemId: hostItemIdSchema.parse(`copilot-${randomUUID()}`),
          toolName: str(call.title) || "Copilot tool",
          arguments: jsonValueSchema.safeParse(call.rawInput ?? {}).success
            ? jsonValueSchema.parse(call.rawInput ?? {})
            : {},
        };
        snapshot = { item, outcome: { status: "cancelled", reason: "Tool did not finish" } };
        active.items.set(key, snapshot);
        this.#emit({ kind: "event", event: { type: "item.started", turnId: active.turnId, item } });
      }
      if (snapshot.item.type !== "toolExecution") return;
      if (Array.isArray(call.content)) {
        const text = call.content
          .flatMap((entry) => {
            const content = record(record(entry).content);
            return content.type === "text" ? [str(content.text)] : [];
          })
          .join("\n")
          .slice(0, 100_000);
        snapshot.item.output = { content: [{ type: "text", text }] };
        this.#emit({
          kind: "event",
          event: {
            type: "item.updated",
            turnId: active.turnId,
            itemId: snapshot.item.itemId,
            update: { type: "output.replace", output: snapshot.item.output },
          },
        });
      }
      if (call.status === "completed" || call.status === "failed" || call.status === "cancelled") {
        snapshot.outcome =
          call.status === "completed"
            ? { status: "succeeded" }
            : call.status === "failed"
              ? { status: "failed", error: errorOf("Copilot tool failed") }
              : { status: "cancelled" };
      }
    }
  }

  #requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const active = this.#active;
    if (!active || this.#closed || request.sessionId !== this.#ref?.nativeSessionId)
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const actions = request.options.flatMap((option) => {
      const effect =
        option.kind === "allow_once"
          ? "allowOnce"
          : option.kind === "allow_always"
            ? "allowForSession"
            : option.kind.startsWith("reject")
              ? "deny"
              : undefined;
      return effect ? [{ id: option.optionId, label: option.name, effect }] : [];
    });
    if (!actions.some((action) => action.effect === "deny"))
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const id = hostInteractionIdSchema.parse(`copilot-${randomUUID()}`);
    const interaction = {
      type: "approval" as const,
      interactionId: id,
      turnId: active.turnId,
      title: request.toolCall.title || "Copilot tool approval",
      subject: { type: "nativeAction" as const },
      actions: actions as Array<{
        id: string;
        label: string;
        effect: "allowOnce" | "allowForSession" | "deny";
      }>,
    };
    return new Promise((resolve) => {
      if (this.#permission) this.#closePermission("superseded");
      this.#permission = { id, turnId: active.turnId, interaction, resolve };
      this.#emit({ kind: "interaction", interaction });
    });
  }

  #closePermission(reason: "cancelled" | "superseded") {
    const pending = this.#permission;
    if (!pending) return;
    this.#permission = undefined;
    pending.resolve({ outcome: { outcome: "cancelled" } });
    this.#emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: pending.id,
        turnId: pending.turnId,
        reason,
      },
    });
  }

  async #selectModel(id: string): Promise<void> {
    if (!this.#ref) throw new Error("Session is not open");
    if (!this.#catalog?.models.some((model) => model.ref.id === id))
      throw new Error("Model is not in Copilot's native catalog");
    if (copilotNativeContext(id) !== this.#contextTier) {
      this.#configuring = true;
      try {
        await this.#replaceClient(copilotNativeContext(id), copilotNativeModel(id));
      } finally {
        this.#configuring = false;
      }
      return;
    }
    await this.#configure(
      "model",
      copilotNativeModel(id),
      (config) => config.state.effectiveModel?.id === id,
    );
  }

  async #selectThinking(id: string): Promise<void> {
    if (
      !this.capabilities.configuration.selectThinkingOption ||
      !this.#state.availableThinkingOptions?.some((option) => option.id === id)
    )
      throw new Error("Thinking option is not in Copilot's native catalog");
    await this.#configure(
      "reasoning_effort",
      id,
      (config) => config.state.effectiveThinkingOptionId === id,
    );
  }

  async #selectPermissionMode(id: string): Promise<void> {
    if (
      !this.capabilities.configuration.selectPermissionMode ||
      !COPILOT_PERMISSION_MODES.modes.some((mode) => mode.id === id)
    )
      throw new Error("Permission Mode is not in Copilot's native catalog");
    await this.#configure(
      "allow_all",
      id === "allow-all" ? "on" : "off",
      (config) => config.state.effectivePermissionModeId === id,
    );
  }

  async #replaceClient(contextTier: CopilotContextTier, modelId?: string): Promise<void> {
    if (!this.#ref) throw new Error("Session is not open");
    const previous = this.#state;
    const next = this.#createClient(contextTier);
    try {
      const { config, nativeSessionId } = await restoreCopilotClient(
        next,
        this.input.cwd,
        this.#newSession ? undefined : this.#ref.nativeSessionId,
        contextTier,
        previous,
        modelId,
      );
      if (this.#closed) throw new Error("Copilot Session closed during recovery");
      await this.#client.close();
      if (this.#closed) throw new Error("Copilot Session closed during recovery");
      this.#client = next;
      this.#contextTier = contextTier;
      this.#clientResetRequired = false;
      this.#ref = nativeSessionRefSchema.parse({
        ...this.#ref,
        nativeSessionId,
        locator: { cwd: this.input.cwd, contextTier },
      });
      this.capabilities = config.capabilities;
      this.#catalog = config.catalog;
      this.#state = { ...(!this.#newSession ? { nativeRef: this.#ref } : {}), ...config.state };
      this.#emit({ kind: "event", event: { type: "session.state.changed", state: this.#state } });
    } catch (error) {
      await next.close().catch(() => {});
      throw error;
    }
  }

  async #forceCancel(active: ActiveTurn): Promise<void> {
    if (this.#active !== active) return;
    this.#clientResetRequired = true;
    try {
      await this.#client.close();
    } finally {
      active.abort.abort();
    }
  }

  async #configure(
    key: string,
    value: string,
    verify: (config: ReturnType<typeof copilotConfiguration>) => boolean,
  ): Promise<void> {
    if (!this.#ref) throw new Error("Session is not open");
    this.#configuring = true;
    try {
      const response = await this.#client.setConfigOption(this.#ref.nativeSessionId, key, value);
      const confirmed = copilotConfiguration(response, this.#contextTier);
      if (!verify(confirmed)) throw new Error(`Copilot did not confirm ${key} selection`);
      this.capabilities = confirmed.capabilities;
      this.#catalog = confirmed.catalog;
      this.#state = { ...(!this.#newSession ? { nativeRef: this.#ref } : {}), ...confirmed.state };
      this.#emit({ kind: "event", event: { type: "session.state.changed", state: this.#state } });
    } finally {
      this.#configuring = false;
    }
  }

  async execute(command: HostCommand): Promise<HarnessResult<never>> {
    if (this.#closed || this.#fault || !this.#ref)
      return failure("invalidState", "Session is closed or unavailable");
    if (
      command.type === "model.select" ||
      command.type === "thinking.select" ||
      command.type === "permissionMode.select"
    ) {
      if (this.#active || this.#configuring)
        return failure("sessionBusy", "Copilot Session is busy");
      try {
        if (this.#clientResetRequired) {
          this.#configuring = true;
          try {
            await this.#replaceClient(this.#contextTier);
          } finally {
            this.#configuring = false;
          }
        }
        if (command.type === "model.select") await this.#selectModel(command.model.id);
        else if (command.type === "thinking.select")
          await this.#selectThinking(command.thinkingOptionId);
        else await this.#selectPermissionMode(command.permissionModeId);
        return { ok: true, value: { completed: true } as never };
      } catch (error) {
        return { ok: false, error: errorOf(error, "invalidRequest") };
      }
    }
    if (command.type === "interaction.respond") {
      const pending = this.#permission;
      if (!pending || pending.id !== command.interactionId || command.response.type !== "approval")
        return failure("invalidRequest", "Approval response does not match a pending request");
      const invalid = validateHostApprovalResponse(pending.interaction, command.response);
      if (invalid) return { ok: false, error: invalid };
      pending.resolve({ outcome: { outcome: "selected", optionId: command.response.actionId } });
      this.#permission = undefined;
      this.#emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: command.interactionId,
          turnId: pending.turnId,
          reason: "responded",
        },
      });
      return { ok: true, value: { accepted: true } as never };
    }
    if (command.type === "turn.cancel") {
      if (!this.#active || this.#active.turnId !== command.turnId)
        return failure("invalidState", "Turn is not active");
      const active = this.#active;
      if (!active.cancelled) {
        active.cancelled = true;
        this.#closePermission("cancelled");
        if (!active.promptStarted) active.abort.abort();
        else {
          active.cancellationTimer = setTimeout(() => {
            void this.#forceCancel(active).catch(() => {});
          }, this.cancellationTimeoutMs);
          void this.#client
            .cancel(this.#ref.nativeSessionId)
            .catch(() => this.#forceCancel(active));
        }
      }
      return { ok: true, value: { cancellationRequested: true } as never };
    }
    if (command.type !== "turn.start") return failure("unsupported", "Unknown Copilot command");
    if (this.#active || this.#configuring) return failure("sessionBusy", "Copilot Session is busy");
    const text = command.input.map((part) => part.text).join("\n");
    if (!text) return failure("invalidRequest", "Turn input is empty");
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active: ActiveTurn = {
      turnId: command.turnId,
      cancelled: false,
      promptStarted: false,
      abort: new AbortController(),
      done,
      finish,
      items: new Map<string, HostItemSnapshot>(),
    };
    this.#active = active;
    this.#emit({ kind: "event", event: { type: "turn.started", turnId: command.turnId } });
    void this.#runTurn(text, active);
    return { ok: true, value: { turnId: command.turnId } as never };
  }

  async #runTurn(text: string, active: ActiveTurn) {
    let outcome: { status: "succeeded" | "cancelled" } | { status: "failed"; error: HarnessError } =
      { status: "failed", error: errorOf("Copilot Turn ended without a result") };
    const ref = this.#ref;
    if (!ref) return;
    let nativeTurnRef: HostThreadSnapshot["turns"][number]["nativeTurnRef"] | undefined;
    let readingHistory = false;
    let rejectCancellation!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const abort = () => rejectCancellation(new Error("Copilot Turn cancelled"));
    active.abort.signal.addEventListener("abort", abort, { once: true });
    if (active.abort.signal.aborted) abort();
    try {
      if (this.#clientResetRequired)
        await Promise.race([this.#replaceClient(this.#contextTier), cancelled]);
      // A fresh Session can legitimately have no event file until its first prompt.
      // After any prompt attempt, never treat a missing history as a new Session.
      let before: HostThreadSnapshot;
      readingHistory = true;
      try {
        before = await Promise.race([this.history(ref, this.environment), cancelled]);
      } catch (error) {
        if (!this.#newSession || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        before = { turns: [] };
      }
      if (active.cancelled || this.#closed) {
        outcome = { status: "cancelled" };
        return;
      }
      const known = new Set(before.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey));
      this.#newSession = false;
      readingHistory = false;
      active.promptStarted = true;
      const response = await Promise.race([
        this.#client.prompt(ref.nativeSessionId, text),
        cancelled,
      ]);
      readingHistory = true;
      const after = await this.history(ref, this.environment);
      const added = after.turns.filter((turn) => !known.has(turn.nativeTurnRef.nativeTurnKey));
      if (added.length !== 1 || added[0]?.input[0]?.text !== text)
        throw new Error("Copilot native history did not confirm exactly one submitted Turn");
      nativeTurnRef = added[0].nativeTurnRef;
      this.#state = { ...this.#state, nativeRef: this.#ref ?? ref };
      this.#emit({ kind: "event", event: { type: "session.state.changed", state: this.#state } });
      outcome =
        active.cancelled || response.stopReason === "cancelled"
          ? { status: "cancelled" }
          : response.stopReason === "end_turn"
            ? { status: "succeeded" }
            : { status: "failed", error: errorOf(`ACP stopped with ${str(response.stopReason)}`) };
    } catch (error) {
      outcome = active.cancelled
        ? { status: "cancelled" }
        : { status: "failed", error: errorOf(error, readingHistory ? "protocolError" : undefined) };
    } finally {
      clearTimeout(active.cancellationTimer);
      active.abort.signal.removeEventListener("abort", abort);
      if (this.#clientResetRequired) await this.#client.close().catch(() => {});
      this.#closePermission("cancelled");
      for (const snapshot of active.items.values())
        this.#emit({
          kind: "event",
          event: { type: "item.completed", turnId: active.turnId, snapshot },
        });
      this.#emit({
        kind: "event",
        event: {
          type: "turn.completed",
          turnId: active.turnId,
          ...(nativeTurnRef ? { nativeTurnRef } : {}),
          outcome,
        },
      });
      if (this.#active === active) this.#active = undefined;
      active.finish();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#active;
    if (active) {
      active.cancelled = true;
      active.abort.abort();
    }
    this.#closePermission("cancelled");
    try {
      await this.#client.close();
      await active?.done;
    } finally {
      this.#channel.end();
      this.onClose();
    }
  }
}
