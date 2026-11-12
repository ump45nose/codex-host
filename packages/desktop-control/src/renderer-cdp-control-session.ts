import {
  CdpClient,
  CdpConnectionClosedError,
  listCdpTargets,
  type CdpClientOptions,
  type CdpFetch,
  type CdpTarget,
  cdpExceptionMessage,
} from "./cdp-client.js";
import {
  installRendererDraftPrewarmPolicyDirect,
  type RendererDraftPrewarmPolicyStatus,
} from "./renderer-draft-prewarm-policy.js";

import { syncMacOsOpenPanelDefaultDirectory } from "./macos-open-panel-default-dir.js";
import {
  installRendererLoadedModules,
  type RendererModuleCdpClient,
} from "./renderer-loaded-modules.js";
import { installNativeRpcRemoteControlDirect } from "./renderer-native-rpc-install.js";
import { installRendererRpcSteeringDirect } from "./renderer-rpc-steering.js";

export interface ProductionRendererStatus {
  version: 2;
  enabledAgents: string[];
  adapter: {
    state: "ready";
    reason: string;
  };
}

export interface RendererCdpControlSnapshot {
  target: CdpTarget;
  draftPrewarmPolicy: RendererDraftPrewarmPolicyStatus;
  binding: ProductionRendererStatus;
}

interface RendererCdpClient extends RendererModuleCdpClient {
  evaluate<T>(expression: string): Promise<T>;
  close(): void;
}

interface RendererCdpControlOperations {
  listTargets(endpoint: string, signal?: AbortSignal): Promise<CdpTarget[]>;
  connect(webSocketDebuggerUrl: string): Promise<RendererCdpClient>;
  installDraftPrewarmPolicy(renderer: RendererCdpClient): Promise<RendererDraftPrewarmPolicyStatus>;
}

export interface RendererCdpControlSession {
  readonly snapshot: RendererCdpControlSnapshot;
  ensureInstalled(): Promise<RendererCdpControlSnapshot>;
  activateDesktop(): Promise<number>;
  executeRenderer<T>(expression: string): Promise<T>;
  close(): void;
}

export interface InstallRendererCdpControlOptions {
  rendererCdpEndpoint: string;
  rendererSource: string;
  enabledAgents?: readonly string[];
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface CreateRendererCdpControlOptions extends InstallRendererCdpControlOptions {
  operations?: RendererCdpControlOperations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function discoveryTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

function abortFailure(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortFailure(signal, timeoutMessage));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(abortFailure(signal, timeoutMessage));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sameAgents(actual: readonly string[], expected: readonly string[] | undefined): boolean {
  // Production discovers plugins after mounting. Explicit tooling expectations stay exact.
  if (!actual.includes("codex") || new Set(actual).size !== actual.length) return false;
  if (!expected) return true;
  const expectedSet = new Set(expected);
  return actual.length === expected.length && actual.every((agent) => expectedSet.has(agent));
}

function isPrimaryRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "app:" &&
      url.hostname === "-" &&
      url.pathname === "/index.html" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function selectPrimaryRendererTarget(
  targets: readonly CdpTarget[],
  preferredTargetId?: string,
): CdpTarget | null {
  const candidates = targets.filter(
    (target) => target.type === "page" && isPrimaryRendererUrl(target.url),
  );
  return candidates.find((target) => target.id === preferredTargetId) ?? candidates.at(0) ?? null;
}

export function isAvatarOverlayRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "app:") return false;
    if (url.pathname === "/avatar-overlay" || url.pathname.endsWith("/avatar-overlay.html"))
      return true;
    const rawRoute = url.searchParams.get("initialRoute") ?? "";
    let decoded = rawRoute;
    try {
      decoded = decodeURIComponent(rawRoute);
    } catch {}
    return (
      [rawRoute, decoded].some(
        (r) =>
          r === "/avatar-overlay" ||
          r.startsWith("/avatar-overlay?") ||
          r.startsWith("/avatar-overlay/"),
      ) || url.searchParams.get("desktopSurface") === "avatarOverlay"
    );
  } catch {
    return false;
  }
}

export function selectAvatarOverlayRendererTargets(targets: readonly CdpTarget[]): CdpTarget[] {
  return targets.filter(
    (target) => target.type === "page" && isAvatarOverlayRendererUrl(target.url),
  );
}

const AVATAR_OVERLAY_INSTALLED_EXPR =
  'document.documentElement?.getAttribute("data-codexhost-avatar-overlay") === "true"';

class RendererAdapterReadinessError extends Error {
  constructor(
    readonly state: string,
    readonly reason: string,
  ) {
    super(`Production Renderer Adapter is ${state}: ${reason}`);
    this.name = "RendererAdapterReadinessError";
  }
}

function validateBindingStatus(
  value: unknown,
  expectedAgents: readonly string[] | undefined,
): ProductionRendererStatus {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Array.isArray(value.enabledAgents) ||
    value.enabledAgents.some((agent) => typeof agent !== "string") ||
    !sameAgents(value.enabledAgents as string[], expectedAgents) ||
    !isRecord(value.adapter)
  ) {
    throw new Error("Production Renderer binding returned an invalid status");
  }
  if (value.adapter.state !== "ready" || typeof value.adapter.reason !== "string") {
    const state = typeof value.adapter.state === "string" ? value.adapter.state : "invalid";
    const reason = typeof value.adapter.reason === "string" ? value.adapter.reason : "unknown";
    throw new RendererAdapterReadinessError(state, reason);
  }
  return value as unknown as ProductionRendererStatus;
}

async function waitForPrimaryTarget(
  endpoint: string,
  operations: RendererCdpControlOperations,
  timeoutMs: number,
  pollIntervalMs: number,
  preferredTargetId?: string,
  signal?: AbortSignal,
): Promise<{ target: CdpTarget; targets: readonly CdpTarget[] }> {
  const discovery = discoveryTimeoutSignal(timeoutMs, signal);
  let lastError: unknown;
  while (!discovery.aborted) {
    try {
      const targets = await awaitWithSignal(
        operations.listTargets(endpoint, discovery),
        discovery,
        "Renderer CDP target discovery timed out",
      );
      const target = selectPrimaryRendererTarget(targets, preferredTargetId);
      if (target) {
        return { target, targets };
      }
      lastError = new Error("Renderer CDP has no primary app://-/index.html page target");
    } catch (error) {
      lastError = error;
      if (discovery.aborted) break;
    }
    if (discovery.aborted) break;
    try {
      await awaitWithSignal(
        sleep(pollIntervalMs),
        discovery,
        "Renderer CDP target discovery timed out",
      );
    } catch (error) {
      lastError = error;
      break;
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Primary Codex Renderer CDP target did not become ready${detail}`);
}

async function evaluateSource(renderer: RendererCdpClient, source: string): Promise<void> {
  const response = await renderer.command("Runtime.evaluate", {
    expression: source,
    awaitPromise: true,
  });
  if (!isRecord(response)) throw new Error("Renderer source evaluation returned an invalid result");
  if (isRecord(response.exceptionDetails)) {
    throw new Error(
      cdpExceptionMessage(response.exceptionDetails, "Renderer source evaluation failed"),
    );
  }
}

async function readBinding(renderer: RendererCdpClient): Promise<unknown> {
  return renderer.evaluate<unknown>("window.__codexhostRendererBindingProbeV1?.status() ?? null");
}

async function waitForBinding(
  renderer: RendererCdpClient,
  enabledAgents: readonly string[] | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ProductionRendererStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await readBinding(renderer);
      if (value !== null) return validateBindingStatus(value, enabledAgents);
    } catch (error) {
      lastError = error;
      if (error instanceof CdpConnectionClosedError) throw error;
      if (error instanceof RendererAdapterReadinessError && error.state !== "installing") {
        throw error;
      }
    }
    await sleep(pollIntervalMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Production Renderer binding did not become ready${detail}`);
}

async function installTarget(
  target: CdpTarget,
  rendererSource: string,
  enabledAgents: readonly string[] | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
  operations: RendererCdpControlOperations,
): Promise<{
  renderer: RendererCdpClient;
  snapshot: RendererCdpControlSnapshot;
  disposeModules(): void;
}> {
  const renderer = await operations.connect(target.webSocketDebuggerUrl);
  let disposeModules: (() => void) | undefined;
  try {
    disposeModules = await installRendererLoadedModules(renderer);
    await renderer.command("Page.enable");
    await renderer.command("Page.addScriptToEvaluateOnNewDocument", { source: rendererSource });
    await evaluateSource(renderer, rendererSource);
    const draftPrewarmPolicy = await operations.installDraftPrewarmPolicy(renderer);
    const binding = await waitForBinding(renderer, enabledAgents, timeoutMs, pollIntervalMs);
    return { renderer, snapshot: { target, draftPrewarmPolicy, binding }, disposeModules };
  } catch (error) {
    disposeModules?.();
    renderer.close();
    throw error;
  }
}

class InstalledRendererCdpControlSession implements RendererCdpControlSession {
  #closed = false;
  readonly #overlayClients = new Map<string, RendererCdpClient>();
  #overlayPollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private renderer: RendererCdpClient,
    private readonly rendererCdpEndpoint: string,
    private readonly rendererSource: string,
    private readonly enabledAgents: readonly string[] | undefined,
    private readonly timeoutMs: number,
    private readonly pollIntervalMs: number,
    private readonly operations: RendererCdpControlOperations,
    private currentSnapshot: RendererCdpControlSnapshot,
    private disposeModules: () => void,
  ) {
    this.#scheduleOverlayPoll();
  }

  get snapshot(): RendererCdpControlSnapshot {
    return this.currentSnapshot;
  }

  #scheduleOverlayPoll(): void {
    if (this.#closed || this.#overlayPollTimer) return;
    this.#overlayPollTimer = setTimeout(
      () => {
        this.#overlayPollTimer = null;
        void this.reconcileAvatarOverlays().finally(() => this.#scheduleOverlayPoll());
      },
      Math.max(this.pollIntervalMs, 250),
    );
    this.#overlayPollTimer.unref?.();
  }

  async reconcileAvatarOverlays(
    knownTargets?: readonly CdpTarget[],
    verifyExisting = false,
  ): Promise<void> {
    if (this.#closed) return;
    const discovery = discoveryTimeoutSignal(Math.min(this.timeoutMs, 2_000));
    const targets =
      knownTargets ??
      (await awaitWithSignal(
        this.operations.listTargets(this.rendererCdpEndpoint, discovery),
        discovery,
        "Avatar overlay CDP target discovery timed out",
      ).catch(() => null));
    if (!targets || this.#closed) return;
    const overlays = selectAvatarOverlayRendererTargets(targets);
    const activeIds = new Set(overlays.map((item) => item.id));
    for (const [targetId, client] of this.#overlayClients) {
      if (!activeIds.has(targetId)) {
        this.#overlayClients.delete(targetId);
        client.close();
      }
    }
    for (const overlay of overlays) {
      if (this.#closed) return;
      const existing = this.#overlayClients.get(overlay.id);
      if (existing) {
        if (!verifyExisting) continue;
        try {
          if (!(await existing.evaluate<boolean>(AVATAR_OVERLAY_INSTALLED_EXPR)))
            await evaluateSource(existing, this.rendererSource);
          continue;
        } catch {
          this.#overlayClients.delete(overlay.id);
          existing.close();
        }
      }
      let client: RendererCdpClient | null = null;
      try {
        client = await this.operations.connect(overlay.webSocketDebuggerUrl);
        if (this.#closed) {
          client.close();
          return;
        }
        if (!(await client.evaluate<boolean>(AVATAR_OVERLAY_INSTALLED_EXPR))) {
          await client.command("Page.enable");
          await client.command("Page.addScriptToEvaluateOnNewDocument", {
            source: this.rendererSource,
          });
          await evaluateSource(client, this.rendererSource);
        }
        this.#overlayClients.set(overlay.id, client);
      } catch {
        client?.close();
      }
    }
  }

  async ensureInstalled(): Promise<RendererCdpControlSnapshot> {
    if (this.#closed) throw new Error("Renderer CDP Control Session is closed");
    const { target, targets } = await waitForPrimaryTarget(
      this.rendererCdpEndpoint,
      this.operations,
      this.timeoutMs,
      this.pollIntervalMs,
      this.currentSnapshot.target.id,
    );
    await this.reconcileAvatarOverlays(targets, true);
    if (target.id !== this.currentSnapshot.target.id) {
      const replacement = await installTarget(
        target,
        this.rendererSource,
        this.enabledAgents,
        this.timeoutMs,
        this.pollIntervalMs,
        this.operations,
      );
      this.disposeModules();
      this.renderer.close();
      this.renderer = replacement.renderer;
      this.disposeModules = replacement.disposeModules;
      this.currentSnapshot = replacement.snapshot;
      return this.currentSnapshot;
    }

    try {
      const existing = await readBinding(this.renderer);
      if (existing === null) await evaluateSource(this.renderer, this.rendererSource);
      // A Host switch can temporarily leave the Adapter installing. Reconcile
      // native owners before validating readiness; that is not a lost CDP page.
      const draftPrewarmPolicy = await this.operations.installDraftPrewarmPolicy(this.renderer);
      const binding = await waitForBinding(
        this.renderer,
        this.enabledAgents,
        this.timeoutMs,
        this.pollIntervalMs,
      );
      this.currentSnapshot = { target, draftPrewarmPolicy, binding };
      return this.currentSnapshot;
    } catch {
      const replacement = await installTarget(
        target,
        this.rendererSource,
        this.enabledAgents,
        this.timeoutMs,
        this.pollIntervalMs,
        this.operations,
      );
      this.disposeModules();
      this.renderer.close();
      this.renderer = replacement.renderer;
      this.disposeModules = replacement.disposeModules;
      this.currentSnapshot = replacement.snapshot;
      return this.currentSnapshot;
    }
  }

  async activateDesktop(): Promise<number> {
    if (this.#closed) throw new Error("Renderer CDP Control Session is closed");
    await this.renderer.command("Page.bringToFront");
    return 1;
  }

  executeRenderer<T>(expression: string): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Renderer CDP Control Session is closed"));
    return this.renderer.evaluate<T>(expression);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#overlayPollTimer) clearTimeout(this.#overlayPollTimer);
    for (const client of this.#overlayClients.values()) client.close();
    this.#overlayClients.clear();
    this.disposeModules();
    this.renderer.close();
  }
}

const defaultOperations: RendererCdpControlOperations = {
  listTargets: (endpoint, signal) => listCdpTargets(endpoint, fetch, signal),
  connect: (webSocketDebuggerUrl) => CdpClient.connect(webSocketDebuggerUrl),
  async installDraftPrewarmPolicy(renderer) {
    const status = await installRendererDraftPrewarmPolicyDirect(renderer);
    await installNativeRpcRemoteControlDirect(renderer);
    await installRendererRpcSteeringDirect(renderer);
    await syncMacOsOpenPanelDefaultDirectory(renderer);
    return status;
  },
};

export async function createRendererCdpControlSession(
  options: CreateRendererCdpControlOptions,
): Promise<RendererCdpControlSession> {
  const enabledAgents = options.enabledAgents;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const operations = options.operations ?? defaultOperations;
  const { target, targets } = await waitForPrimaryTarget(
    options.rendererCdpEndpoint,
    operations,
    timeoutMs,
    pollIntervalMs,
    undefined,
    options.signal,
  );
  const installed = await installTarget(
    target,
    options.rendererSource,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
    operations,
  );
  const session = new InstalledRendererCdpControlSession(
    installed.renderer,
    options.rendererCdpEndpoint,
    options.rendererSource,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
    operations,
    installed.snapshot,
    installed.disposeModules,
  );
  await session.reconcileAvatarOverlays(targets);
  return session;
}

export function installRendererCdpControlSession(
  options: InstallRendererCdpControlOptions,
): Promise<RendererCdpControlSession> {
  return createRendererCdpControlSession(options);
}

export type RendererCdpFetch = CdpFetch;
export type RendererCdpClientOptions = CdpClientOptions;
