import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { CopilotContextTier } from "./configuration.js";
import { copilotInvocation } from "./command.js";

export interface CopilotClient {
  initialize(): Promise<unknown>;
  open(cwd: string, sessionId?: string): Promise<Record<string, unknown>>;
  prompt(sessionId: string, text: string): Promise<Record<string, unknown>>;
  cancel(sessionId: string): Promise<void>;
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface CopilotClientOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
  contextTier?: CopilotContextTier;
  onUpdate(notification: SessionNotification): void;
  onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  onFault(error: unknown): void;
}

export class CopilotAcpClient implements CopilotClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #connection: ClientSideConnection;
  readonly #exited: Promise<void>;
  readonly #failed: Promise<never>;
  #rejectFailure!: (error: unknown) => void;
  #failure: unknown;
  #closing: Promise<void> | undefined;

  constructor(readonly options: CopilotClientOptions) {
    const invocation = copilotInvocation(options.environment, options.command, options.contextTier);
    this.#failed = new Promise((_, reject) => (this.#rejectFailure = reject));
    void this.#failed.catch(() => {});
    this.#child = spawn(invocation.command, invocation.arguments, {
      cwd: options.cwd,
      env: options.environment,
      stdio: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    this.#exited = new Promise((resolve) => this.#child.once("close", () => resolve()));
    this.#child.stderr.on("data", () => {
      // Native stderr can contain private prompts or credentials.
    });
    this.#child.stdin.on("error", () => {});
    this.#child.on("error", (error) => this.#fault(error));
    this.#child.once("exit", (code) => this.#fault(new Error(`Copilot ACP exited (${code})`)));
    this.#connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (notification) => {
          if (!this.#closing && !this.#failure) options.onUpdate(notification);
        },
        requestPermission: (request) =>
          this.#closing || this.#failure
            ? Promise.resolve({ outcome: { outcome: "cancelled" } })
            : options.onPermission(request),
      }),
      ndJsonStream(
        Writable.toWeb(this.#child.stdin) as Parameters<typeof ndJsonStream>[0],
        Readable.toWeb(this.#child.stdout) as Parameters<typeof ndJsonStream>[1],
      ),
    );
    void this.#connection.closed.then(
      () => this.#fault(new Error("Copilot ACP connection closed")),
      (error) => this.#fault(error),
    );
  }

  #fault(error: unknown) {
    if (this.#closing || this.#failure) return;
    this.#failure = error;
    this.#rejectFailure(error);
    this.options.onFault(error);
    void this.close().catch(() => {});
  }

  async #request<T>(action: () => Promise<T>, label: string): Promise<T> {
    if (this.#failure) throw this.#failure;
    if (this.#closing) throw new Error("Copilot ACP client is closed");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        action(),
        this.#failed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              const error = new Error(`${label} timed out`);
              this.#fault(error);
              reject(error);
            },
            label === "ACP prompt" ? 15 * 60_000 : 30_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async initialize() {
    const response = await this.#request(
      () =>
        this.#connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "codexhost", version: "0.0.0" },
          clientCapabilities: {},
        }),
      "ACP initialize",
    );
    if (response.protocolVersion !== PROTOCOL_VERSION || !response.agentCapabilities?.loadSession)
      throw new Error("Copilot ACP session/load is required for persistent Threads");
    return response;
  }

  async open(cwd: string, sessionId?: string) {
    return (await this.#request(
      () =>
        sessionId
          ? this.#connection.loadSession({ cwd, sessionId, mcpServers: [] })
          : this.#connection.newSession({ cwd, mcpServers: [] }),
      "ACP session open",
    )) as Record<string, unknown>;
  }

  async prompt(sessionId: string, text: string) {
    return (await this.#request(
      () => this.#connection.prompt({ sessionId, prompt: [{ type: "text", text }] }),
      "ACP prompt",
    )) as Record<string, unknown>;
  }

  async cancel(sessionId: string) {
    await this.#request(() => this.#connection.cancel({ sessionId }), "ACP cancel");
  }

  async setConfigOption(sessionId: string, configId: string, value: string) {
    return (await this.#request(
      () => this.#connection.setSessionConfigOption({ sessionId, configId, value }),
      "ACP configuration",
    )) as Record<string, unknown>;
  }

  async close() {
    if (this.#closing) return this.#closing;
    this.#rejectFailure(new Error("Copilot ACP client is closed"));
    this.#closing = (async () => {
      this.#child.stdin.end();
      if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (this.#child.exitCode === null && this.#child.signalCode === null)
        this.#child.kill("SIGKILL");
      await this.#exited;
    })();
    return this.#closing;
  }
}
