import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export interface ZCodeAppServerOptions {
  command?: string;
  cwd: string;
  environment?: Record<string, string | undefined>;
}

type Envelope = Record<string, unknown>;
type NotificationListener = (message: Envelope) => void;

/** Error carrying the native protocol response for deterministic Host error mapping. */
export class ZCodeAppServerError extends Error {
  constructor(
    message: string,
    readonly kind: "notInstalled" | "protocol" | "processExited",
  ) {
    super(message);
    this.name = "ZCodeAppServerError";
  }
}

/** Owns one native `zcode app-server` child and its newline-delimited request lifecycle. */
export class ZCodeAppServer {
  readonly #options: ZCodeAppServerOptions;
  readonly #listeners = new Set<NotificationListener>();
  readonly #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  #child: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  #stderr = "";

  constructor(options: ZCodeAppServerOptions) {
    this.#options = options;
  }

  get stderrTail(): string {
    return this.#stderr.slice(-4_000);
  }

  /** Starts the native server and installs protocol handlers before the first request. */
  async start(): Promise<void> {
    if (this.#child) return;
    await new Promise<void>((resolve, reject) => {
      const environment = Object.fromEntries(
        Object.entries({ ...process.env, ...this.#options.environment }).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      const child = spawn(this.#options.command ?? "zcode", ["app-server"], {
        cwd: this.#options.cwd,
        env: environment,
        stdio: "pipe",
      });
      this.#child = child;
      child.once("spawn", resolve);
      child.once("error", (error: NodeJS.ErrnoException) => {
        this.#child = null;
        reject(
          new ZCodeAppServerError(
            error.code === "ENOENT" ? "ZCode CLI is not installed" : error.message,
            error.code === "ENOENT" ? "notInstalled" : "processExited",
          ),
        );
      });
      child.stderr.on("data", (chunk: Buffer) => {
        this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-8_000);
      });
      readline.createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(line));
      child.once("exit", (code, signal) => {
        this.#child = null;
        const error = new ZCodeAppServerError(
          `ZCode app-server exited (${signal ?? code ?? "unknown"})`,
          "processExited",
        );
        for (const request of this.#pending.values()) request.reject(error);
        this.#pending.clear();
      });
    });
  }

  /** Registers a listener for server notifications such as streamed session events. */
  onNotification(listener: NotificationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Sends one typed-by-caller native request and resolves its result envelope. */
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.start();
    const child = this.#child;
    if (!child) throw new ZCodeAppServerError("ZCode app-server is not running", "processExited");
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) =>
      this.#pending.set(id, { resolve, reject }),
    );
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return (await result) as T;
  }

  /** Stops the child process and rejects any request that can no longer complete. */
  async close(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 1_000).unref();
    });
  }

  #onLine(line: string): void {
    let message: Envelope;
    try {
      message = JSON.parse(line) as Envelope;
    } catch {
      return;
    }
    const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : null;
    if (id !== null && typeof message.method === "string") {
      this.#handleServerRequest(id, message.method, message.params);
      return;
    }
    if (typeof id === "number") {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      const error = message.error as { message?: unknown } | undefined;
      if (error) {
        pending.reject(
          new ZCodeAppServerError(
            String(error.message ?? "ZCode protocol request failed"),
            "protocol",
          ),
        );
      } else pending.resolve(message.result);
      return;
    }
    for (const listener of this.#listeners) listener(message);
  }

  #handleServerRequest(id: number | string, method: string, params: unknown): void {
    const child = this.#child;
    if (!child) return;
    let result: unknown;
    if (method === "session/requestRuntimePreferences") {
      // CodexHost does not currently supply ZCode-native memory/search integrations.
      result = {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
      };
    } else if (method === "interaction/requestOfficialMcpAuthHeaders") {
      result = { ok: true, headers: {} };
    } else if (method === "interaction/requestProviderRuntimeHeaders") {
      result = { headersApplied: false };
    } else if (method === "interaction/requestPermission") {
      const request = params as { options?: Array<{ response?: unknown }> } | undefined;
      // Until Host approval bridging lands, select only a native option explicitly marked allow.
      const option = request?.options?.find((candidate) => {
        const response = candidate.response as { decision?: unknown } | undefined;
        return response?.decision === "allow";
      });
      result = option?.response ?? { decision: "deny", reason: "CodexHost approval unavailable" };
    } else if (method === "interaction/requestUserInput") {
      result = { action: "cancel", reason: "CodexHost question bridge unavailable" };
    } else {
      result = {};
    }
    child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }
}
