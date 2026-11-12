import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";
import { DEFAULT_RENDERER_AGENTS, type RendererAgent } from "./agent-selection-state.js";
import { createRendererAgentIcon, rendererAgentLabel } from "./renderer-agent-icon.js";
import {
  RENDERER_NEW_THREAD_PREFERENCE_KEY,
  readNewThreadAgentPreference,
  writeNewThreadAgentPreference,
} from "./renderer-new-thread-preference.js";

export const AVATAR_OVERLAY_STYLE_ID = "codexhost-avatar-overlay-styles";
export const AVATAR_OVERLAY_ROOT_ATTR = "data-codexhost-avatar-overlay";
export const AVATAR_OVERLAY_MENU_OPEN_ATTR = "data-codexhost-avatar-menu-open";
export const AVATAR_OVERLAY_AGENT_PILL_ATTR = "data-codexhost-pets-agent-pill";
export const AVATAR_OVERLAY_AGENT_MENU_ATTR = "data-codexhost-pets-agent-menu";
export const AVATAR_OVERLAY_REMOTE_LIST_ATTR = "data-codexhost-pets-remote-list";
export const AVATAR_OVERLAY_REMOTE_ITEM_ATTR = "data-codexhost-pets-remote-item";
export const AVATAR_OVERLAY_NATIVE_ICON_ATTR = "data-codexhost-pets-native-agent-icon";
export const AVATAR_OVERLAY_NATIVE_TITLE_ATTR = "data-codexhost-pets-native-title";

export const PETS_REMOTE_THREADS_STORAGE_KEY = "codexhost.pets-remote-threads.v1";
export const PETS_HARNESS_CATALOG_STORAGE_KEY = "codexhost.pets-harness-catalog.v1";
export const PETS_OPEN_THREAD_REQUEST_STORAGE_KEY = "codexhost.pets-open-thread-request.v1";
export const DEFAULT_PETS_STACK_MAX_HEIGHT_PX = 520;

export type PetsHarnessCatalogPlugin = Pick<
  HarnessPluginDescriptor,
  "id" | "name" | "icon" | "iconStyle"
>;
export interface PetsHarnessCatalog {
  readonly enabledAgents: readonly RendererAgent[];
  readonly plugins: readonly PetsHarnessCatalogPlugin[];
}

export interface PetsRemoteThreadSummary {
  readonly hostId: string;
  readonly hostLabel?: string | undefined;
  readonly threadId: string;
  readonly title: string;
  readonly status: "waiting" | "failed" | "running" | "unread" | "idle";
  readonly agent?: RendererAgent | undefined;
  readonly plugin?: PetsHarnessCatalogPlugin | undefined;
  readonly preview?: string | undefined;
  readonly updatedAt?: number | undefined;
}

export interface PetsOpenThreadRequest {
  readonly hostId: string;
  readonly threadId: string;
  readonly requestedAt: number;
}

export interface InstallRendererAvatarOverlayOptions {
  readonly document?: Document;
  readonly window?: Window;
  readonly enabledAgents?: readonly RendererAgent[];
  readonly plugins?: readonly PetsHarnessCatalogPlugin[];
}

export interface RendererAvatarOverlayHandle {
  readonly refresh: () => void;
  readonly dispose: () => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isActiveStatus = (s: unknown): s is "waiting" | "failed" | "running" | "unread" =>
  s === "waiting" || s === "failed" || s === "running" || s === "unread";

function sanitizePlugin(raw: unknown): PetsHarnessCatalogPlugin | undefined {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !raw.id ||
    typeof raw.name !== "string" ||
    !raw.name
  )
    return undefined;
  return {
    id: raw.id as HarnessPluginDescriptor["id"],
    name: raw.name,
    ...(typeof raw.icon === "string" && raw.icon ? { icon: raw.icon } : {}),
    ...(isRecord(raw.iconStyle)
      ? { iconStyle: raw.iconStyle as HarnessPluginDescriptor["iconStyle"] }
      : {}),
  };
}

export function isAvatarOverlayRendererUrl(value: string): boolean {
  try {
    const url = new URL(value, "app://-/");
    if (url.pathname === "/avatar-overlay" || url.pathname.endsWith("/avatar-overlay.html"))
      return true;
    const rawRoute = url.searchParams.get("initialRoute") ?? "";
    let decoded = rawRoute;
    try {
      decoded = decodeURIComponent(rawRoute);
    } catch {}
    const surface = url.searchParams.get("desktopSurface");
    return (
      [rawRoute, decoded].some(
        (r) =>
          r === "/avatar-overlay" ||
          r.startsWith("/avatar-overlay?") ||
          r.startsWith("/avatar-overlay/"),
      ) ||
      surface === "avatarOverlay" ||
      surface === "avatar-overlay"
    );
  } catch {
    return false;
  }
}

export function isAvatarOverlayLocation(
  loc: Partial<Pick<Location, "href" | "pathname" | "search">> | null | undefined,
): boolean {
  if (!loc) return false;
  if (loc.href && isAvatarOverlayRendererUrl(loc.href)) return true;
  const pathname = loc.pathname ?? "";
  const search = loc.search ?? "";
  return isAvatarOverlayRendererUrl(
    `app://-${pathname.startsWith("/") ? pathname : `/${pathname}`}${!search || search.startsWith("?") ? search : `?${search}`}`,
  );
}

export function computePetsStackMaxHeightPx(win?: Window | null): number {
  const innerHeight = win?.innerHeight ?? 0;
  const availHeight = innerHeight > 0 ? innerHeight : (win?.screen?.availHeight ?? 0);
  if (availHeight > 0) {
    return Math.max(260, Math.min(DEFAULT_PETS_STACK_MAX_HEIGHT_PX, Math.round(availHeight * 0.6)));
  }
  return DEFAULT_PETS_STACK_MAX_HEIGHT_PX;
}

export function readPetsRemoteThreads(
  storage?: Pick<Storage, "getItem"> | null,
): PetsRemoteThreadSummary[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PETS_REMOTE_THREADS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result: PetsRemoteThreadSummary[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) continue;
      const { hostId, hostLabel, threadId, title, status, agent, plugin, preview, updatedAt } =
        item;
      if (
        typeof hostId !== "string" ||
        hostId.length === 0 ||
        typeof threadId !== "string" ||
        threadId.length === 0 ||
        typeof title !== "string" ||
        !isActiveStatus(status)
      ) {
        continue;
      }
      const cleanPlugin = sanitizePlugin(plugin);
      result.push({
        hostId,
        ...(typeof hostLabel === "string" && hostLabel ? { hostLabel } : {}),
        threadId,
        title,
        status,
        ...(typeof agent === "string" && agent ? { agent: agent as RendererAgent } : {}),
        ...(cleanPlugin ? { plugin: cleanPlugin } : {}),
        ...(typeof preview === "string" && preview.length > 0 ? { preview } : {}),
        ...(typeof updatedAt === "number" && Number.isFinite(updatedAt) ? { updatedAt } : {}),
      });
    }
    return result;
  } catch {
    return [];
  }
}

export function writePetsRemoteThreads(
  threads: readonly PetsRemoteThreadSummary[],
  storage?: Pick<Storage, "setItem"> | null,
): void {
  if (!storage) return;
  try {
    const active = threads.filter(
      (t) => Boolean(t.hostId && t.threadId) && isActiveStatus(t.status),
    );
    storage.setItem(PETS_REMOTE_THREADS_STORAGE_KEY, JSON.stringify(active));
  } catch {
    // Ignore storage quota errors
  }
}

export function readPetsHarnessCatalog(
  storage?: Pick<Storage, "getItem"> | null,
): PetsHarnessCatalog | null {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(PETS_HARNESS_CATALOG_STORAGE_KEY) ?? "");
    if (!isRecord(parsed)) return null;
    const plugins = (Array.isArray(parsed.plugins) ? parsed.plugins : [])
      .map(sanitizePlugin)
      .filter((p): p is PetsHarnessCatalogPlugin => Boolean(p));
    const rawAgents = Array.isArray(parsed.enabledAgents) ? parsed.enabledAgents : [];
    const enabledAgents = Array.from(
      new Set<RendererAgent>([
        "codex",
        ...rawAgents.filter((a): a is RendererAgent => typeof a === "string" && a.length > 0),
        ...plugins.map((p) => p.id as RendererAgent),
      ]),
    );
    return { enabledAgents, plugins };
  } catch {
    return null;
  }
}

export function writePetsHarnessCatalog(
  catalog: PetsHarnessCatalog,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const enabledAgents = Array.from(
      new Set<RendererAgent>([
        "codex",
        ...catalog.enabledAgents.filter(
          (a): a is RendererAgent => typeof a === "string" && a.length > 0,
        ),
      ]),
    );
    const plugins = catalog.plugins
      .map(sanitizePlugin)
      .filter((p): p is PetsHarnessCatalogPlugin => Boolean(p));
    storage?.setItem(PETS_HARNESS_CATALOG_STORAGE_KEY, JSON.stringify({ enabledAgents, plugins }));
  } catch {}
}

export function requestPetsOpenThreadInMainWindow(
  request: { hostId: string; threadId: string },
  storage?: Pick<Storage, "setItem"> | null,
): void {
  if (!storage) return;
  try {
    const payload: PetsOpenThreadRequest = {
      hostId: request.hostId,
      threadId: request.threadId,
      requestedAt: Date.now(),
    };
    storage.setItem(PETS_OPEN_THREAD_REQUEST_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage errors
  }
}

export function readPetsOpenThreadRequest(
  storage?: Pick<Storage, "getItem"> | null,
): PetsOpenThreadRequest | null {
  try {
    const p: unknown = JSON.parse(storage?.getItem(PETS_OPEN_THREAD_REQUEST_STORAGE_KEY) ?? "");
    if (
      !isRecord(p) ||
      typeof p.hostId !== "string" ||
      !p.hostId ||
      typeof p.threadId !== "string" ||
      !p.threadId
    )
      return null;
    return {
      hostId: p.hostId,
      threadId: p.threadId,
      requestedAt:
        typeof p.requestedAt === "number" && Number.isFinite(p.requestedAt) ? p.requestedAt : 0,
    };
  } catch {
    return null;
  }
}

export function clearPetsOpenThreadRequest(storage?: Pick<Storage, "removeItem"> | null): void {
  try {
    storage?.removeItem(PETS_OPEN_THREAD_REQUEST_STORAGE_KEY);
  } catch {}
}

function mutateStartConversationNode(
  node: unknown,
  modelRoute: string,
  seen = new WeakSet<object>(),
): boolean {
  if (!Array.isArray(node) || seen.has(node)) return false;
  seen.add(node);
  let mutated = false;
  if (
    node[0] === "pipeline" &&
    Array.isArray(node[2]) &&
    node[2].includes("startConversation") &&
    Array.isArray(node[3])
  ) {
    const firstArg =
      Array.isArray(node[3][0]) && node[3].length === 1 && isRecord(node[3][0][0])
        ? node[3][0][0]
        : node[3][0];
    const input =
      isRecord(firstArg) &&
      isRecord(firstArg.input) &&
      !("collaborationMode" in firstArg) &&
      !("workspaceRoots" in firstArg)
        ? firstArg.input
        : firstArg;
    if (isRecord(input)) {
      const collab = isRecord(input.collaborationMode)
        ? input.collaborationMode
        : (input.collaborationMode = { mode: "default", settings: {} });
      const settings = isRecord(collab.settings) ? collab.settings : (collab.settings = {});
      const config = isRecord(input.config) ? input.config : (input.config = {});
      settings.model = modelRoute;
      config.model = modelRoute;
      mutated = true;
    }
  }
  for (const item of node) if (mutateStartConversationNode(item, modelRoute, seen)) mutated = true;
  return mutated;
}

export function rewriteStartConversationPostMessagePayload(
  payload: unknown,
  selectedAgent: RendererAgent | null | undefined,
): unknown {
  if (!selectedAgent || selectedAgent === "codex") return payload;
  const parsedHarness = harnessIdSchema.safeParse(selectedAgent);
  if (!parsedHarness.success) return payload;
  const modelRoute = encodeHarnessPluginRoute({ harnessId: parsedHarness.data });
  if (typeof payload === "string" && payload.includes("startConversation")) {
    try {
      const parsed: unknown = JSON.parse(payload);
      return mutateStartConversationNode(parsed, modelRoute) ? JSON.stringify(parsed) : payload;
    } catch {
      return payload;
    }
  }
  if (Array.isArray(payload)) mutateStartConversationNode(payload, modelRoute);
  return payload;
}

export function buildAvatarOverlayCss(maxHeightPx: number): string {
  return `
/* CodexHost Pets (avatar-overlay.html) Vertical Screen & Remote Host Enhancements */
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] {
  --codexhost-pets-stack-max-height: min(${maxHeightPx}px, 60vh);
}

/* Expand activity stack scroll viewport from hardcoded 208px to 520px (capped at 60% screen height) */
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-size="notification-tray"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-size="notification-tray-list"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] div:has(> [data-avatar-overlay-size="notification-tray"]) {
  width: auto !important; min-width: 330px !important; height: auto !important; max-height: min(520px, 60vh) !important; overflow: visible !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important;
}
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-size="notification-stack-visible-layout"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-size="notification-stack-visible-layout"] > div,
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-size="notification-stack-backing-layout"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-size="notification-stack-backing-layout"] > div,
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-stack-overflow-mask],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [style*="max-height: 208px"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [style*="max-height:208px"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] .max-h-\\[208px\\],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-codexhost-pets-activity-scroll="true"] {
  position: relative !important; width: auto !important; min-width: 330px !important; height: auto !important; top: auto !important; bottom: auto !important; left: auto !important; right: auto !important; transform: none !important; mask-image: none !important; -webkit-mask-image: none !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important;
  max-height: min(520px, 60vh) !important;
  overflow-y: auto !important;
  overscroll-behavior: contain;
}
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"][${AVATAR_OVERLAY_MENU_OPEN_ATTR}="true"] [data-avatar-overlay-size="notification-tray"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"][${AVATAR_OVERLAY_MENU_OPEN_ATTR}="true"] [data-avatar-overlay-size="notification-tray-list"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-native-surface-id="composer"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-quick-chat-glass-group] { overflow: visible !important; }
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-native-surface-id="composer"] { position: relative !important; min-width: 236px !important; display: inline-flex !important; align-items: center !important; gap: 6px !important; }
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-activity-stack-item] { position: relative !important; top: auto !important; left: auto !important; transform: none !important; opacity: 1 !important; pointer-events: auto !important; display: block !important; margin-bottom: 6px !important; }

/* Allow activity titles to show up to 2 lines and expand cleanly */
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-native-surface-id^="activity-"] {
  min-width: 228px;
  max-width: 344px;
}

html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-native-surface-id^="activity-"] .truncate,
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [${AVATAR_OVERLAY_NATIVE_TITLE_ATTR}="true"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] [data-remote-title] {
  white-space: normal !important;
  display: -webkit-box !important;
  -webkit-line-clamp: 2 !important;
  -webkit-box-orient: vertical !important;
  overflow: hidden !important;
  line-height: 1.3 !important;
}

html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [role="log"] { resize: none !important; }
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [${AVATAR_OVERLAY_NATIVE_ICON_ATTR}="true"],
[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] [data-remote-agent-icon] { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [${AVATAR_OVERLAY_NATIVE_ICON_ATTR}="true"] { margin-inline-end: 6px; }

/* Remote SSH sessions list inside Pets activity stack */
[${AVATAR_OVERLAY_REMOTE_LIST_ATTR}] {
  position: relative; z-index: 30; width: 100%; min-width: 330px; max-height: min(520px, 60vh); overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
  pointer-events: auto;
}

[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%; min-width: 248px; max-width: 344px; min-height: 44px; padding: 8px 14px; border-radius: 28px; border: 1px solid rgba(255, 255, 255, 0.16);
  background: color-mix(in oklab, var(--color-surface, #1e1e1e) 86%, transparent); -webkit-backdrop-filter: blur(18px) saturate(160%); backdrop-filter: blur(18px) saturate(160%); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 10px 26px rgba(0, 0, 0, 0.28);
  color: var(--color-text-primary, #f3f4f6);
  font-size: 12.5px;
  line-height: 1.3;
  text-align: start;
  cursor: pointer;
  pointer-events: auto;
}

[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}]:hover {
  background: color-mix(in oklab, var(--color-surface, #262626) 92%, currentColor 6%);
}

[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] [data-remote-host-badge] {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  background-color: rgba(59, 130, 246, 0.16);
  color: #60a5fa;
  font-size: 10.5px;
  font-weight: 600;
  flex-shrink: 0;
}

[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] [data-remote-title] {
  flex: 1 1 auto;
  min-width: 0;
}

[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] [data-remote-status] {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex-shrink: 0;
}

[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] [data-remote-status="waiting"] {
  background-color: #f59e0b;
}
[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] [data-remote-status="failed"] {
  background-color: #ef4444;
}
[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] [data-remote-status="running"] {
  background-color: #3b82f6;
}
[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] [data-remote-status="unread"] {
  background-color: #10b981;
}

/* Quick Chat Composer Agent Pill */
[${AVATAR_OVERLAY_AGENT_PILL_ATTR}] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid rgba(127, 127, 127, 0.26);
  background-color: color-mix(in oklab, var(--color-surface, #1e1e1e) 90%, currentColor 8%);
  color: var(--color-text-primary, currentColor);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  pointer-events: auto;
  flex-shrink: 0;
}

[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]:hover {
  background-color: color-mix(in oklab, var(--color-surface, #1e1e1e) 84%, currentColor 14%);
}

[${AVATAR_OVERLAY_AGENT_PILL_ATTR}] svg,
[${AVATAR_OVERLAY_AGENT_PILL_ATTR}] img {
  width: 13px;
  height: 13px;
  display: block;
}

[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] {
  position: absolute;
  left: 0;
  z-index: 100;
  min-width: 176px;
  max-height: 240px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 14px;
  background-color: color-mix(in oklab, var(--color-surface, #1e1e1e) 96%, transparent);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  box-shadow:
    inset 0 0 0 1px rgba(127, 127, 127, 0.25),
    0 12px 28px rgba(0, 0, 0, 0.35);
  color: var(--color-text-primary, #f3f4f6);
  font-size: 12px;
  pointer-events: auto;
}

[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] button {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  text-align: start;
  cursor: pointer;
}

[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] button:hover,
[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] button[data-selected="true"] {
  background-color: color-mix(in oklab, currentColor 12%, transparent);
}
`.trim();
}

export function ensureAvatarOverlayStyles(doc: Document, maxHeightPx: number): void {
  let style = doc.getElementById(AVATAR_OVERLAY_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = AVATAR_OVERLAY_STYLE_ID;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  style.textContent = buildAvatarOverlayCss(maxHeightPx);
}

const ACTIVE_HANDLE_SYMBOL = Symbol.for("codexhost.avatarOverlayActiveHandle");

function parseNativeActivitySurfaceId(
  surfaceId: string,
): { hostId: string; threadId: string } | null {
  if (!surfaceId.startsWith("activity-")) return null;
  if (surfaceId.startsWith("activity-local:local:")) {
    const threadId = surfaceId.slice("activity-local:local:".length);
    return threadId ? { hostId: "local", threadId } : null;
  }
  const isRemote = surfaceId.startsWith("activity-remote-host:");
  const rest = surfaceId.slice(isRemote ? "activity-remote-host:".length : "activity-".length);
  const sep = rest.indexOf(":");
  if (sep > 0 && sep < rest.length - 1)
    return { hostId: rest.slice(0, sep), threadId: rest.slice(sep + 1) };
  return !isRemote && rest.length > 0 && sep < 0 ? { hostId: "local", threadId: rest } : null;
}

export function installRendererAvatarOverlay(
  options: InstallRendererAvatarOverlayOptions = {},
): RendererAvatarOverlayHandle {
  const doc = options.document ?? document;
  const win = options.window ?? doc.defaultView ?? window;
  const winState = win as unknown as Record<symbol, RendererAvatarOverlayHandle | undefined>;
  winState[ACTIVE_HANDLE_SYMBOL]?.dispose();

  const maxHeightPx = computePetsStackMaxHeightPx(win);
  doc.documentElement?.setAttribute(AVATAR_OVERLAY_ROOT_ATTR, "true");
  ensureAvatarOverlayStyles(doc, maxHeightPx);

  let disposed = false;
  let isRefreshing = false;
  let closeAgentMenu: (() => void) | null = null;

  const readStorage = (): Storage | null => {
    try {
      return win.localStorage ?? null;
    } catch {
      return null;
    }
  };

  const unhideElementAndAncestors = (el: HTMLElement | null): void => {
    for (const child of el?.querySelectorAll<HTMLElement>('[inert], [aria-hidden="true"]') ?? []) {
      child.removeAttribute("inert");
      child.removeAttribute("aria-hidden");
    }
    for (
      let cur = el;
      cur && cur !== doc.body && cur !== doc.documentElement;
      cur = cur.parentElement
    ) {
      cur.removeAttribute("inert");
      if (cur.getAttribute("aria-hidden") === "true") cur.removeAttribute("aria-hidden");
      if (cur.style.visibility === "hidden") cur.style.visibility = "visible";
      if (cur.style.opacity === "0") cur.style.opacity = "1";
      if (cur.style.width === "0px") cur.style.width = "auto";
      if (cur.style.height === "0px") cur.style.height = "auto";
    }
  };

  const resolveCatalogState = (remoteThreads = readPetsRemoteThreads(readStorage())) => {
    const stored = readPetsHarnessCatalog(readStorage());
    const pluginMap = new Map<string, HarnessPluginDescriptor>();
    for (const raw of [
      ...(options.plugins ?? []),
      ...(stored?.plugins ?? []),
      ...remoteThreads.map((t) => t.plugin),
    ]) {
      const p = sanitizePlugin(raw);
      if (p) pluginMap.set(p.id, p as HarnessPluginDescriptor);
    }
    const candidates = [
      "codex",
      ...(options.enabledAgents ?? []),
      ...(stored?.enabledAgents ?? []),
      ...pluginMap.keys(),
      ...remoteThreads.map((t) => t.agent),
    ].filter((a): a is RendererAgent => typeof a === "string" && a.length > 0);
    const enabledAgents = Array.from(
      new Set<RendererAgent>(
        candidates.length === 1 && !options.enabledAgents && !stored
          ? [...candidates, ...DEFAULT_RENDERER_AGENTS]
          : candidates,
      ),
    );
    return { enabledAgents, enabledAgentsSet: new Set(enabledAgents), pluginMap };
  };

  const messagePortProto = (
    win as unknown as {
      MessagePort?: { prototype?: { postMessage?: typeof MessagePort.prototype.postMessage } };
    }
  ).MessagePort?.prototype;
  const originalPostMessage = messagePortProto?.postMessage;
  let patchedPostMessage: typeof MessagePort.prototype.postMessage | null = null;
  if (messagePortProto && typeof originalPostMessage === "function") {
    patchedPostMessage = function (this: MessagePort, message: unknown, ...rest: unknown[]): void {
      let nextMessage = message;
      try {
        const storage = readStorage();
        const { enabledAgentsSet } = resolveCatalogState(readPetsRemoteThreads(storage));
        const selected = readNewThreadAgentPreference(enabledAgentsSet, storage) ?? "codex";
        if (selected !== "codex")
          nextMessage = rewriteStartConversationPostMessagePayload(message, selected);
      } catch {}
      (originalPostMessage as (this: MessagePort, msg: unknown, ...args: unknown[]) => void).call(
        this,
        nextMessage,
        ...rest,
      );
    } as typeof MessagePort.prototype.postMessage;
    messagePortProto.postMessage = patchedPostMessage;
  }

  const reconcileActivityStackViewport = (): void => {
    const applyStack = (el: HTMLElement, markScroll: boolean): void => {
      if (markScroll && el.getAttribute("data-codexhost-pets-activity-scroll") !== "true")
        el.setAttribute("data-codexhost-pets-activity-scroll", "true");
      if (el.style.width === "0px") el.style.width = "auto";
      if (
        (["0px", "92px", "208px"].includes(el.style.height) || markScroll) &&
        el.style.height !== "auto"
      )
        el.style.height = "auto";
      if (el.style.maxHeight !== "min(520px, 60vh)") el.style.maxHeight = "min(520px, 60vh)";
    };
    for (const c of doc.querySelectorAll<HTMLElement>(
      '[data-avatar-overlay-size^="notification-"], [data-avatar-overlay-stack-overflow-mask]',
    )) {
      const kind = c.getAttribute("data-avatar-overlay-size");
      applyStack(c, kind !== "notification-tray" && kind !== "notification-tray-list");
    }
    for (const item of doc.querySelectorAll<HTMLElement>(
      "[data-avatar-overlay-activity-stack-item]",
    )) {
      item.removeAttribute("inert");
      if (item.getAttribute("aria-hidden") === "true") item.removeAttribute("aria-hidden");
      if (item.getAttribute("data-avatar-overlay-hit-region") !== "activity-pill")
        item.setAttribute("data-avatar-overlay-hit-region", "activity-pill");
    }
  };

  const iconSignature = (agent: string, plugin?: PetsHarnessCatalogPlugin): string =>
    `${agent}:${plugin?.name ?? ""}:${plugin?.icon ?? ""}:${JSON.stringify(plugin?.iconStyle ?? null)}`;

  const reconcileRemoteThreadsList = (
    remoteThreads: readonly PetsRemoteThreadSummary[],
    pluginMap: ReadonlyMap<string, HarnessPluginDescriptor>,
  ): void => {
    const matchedKeys = new Set<string>();
    const byKey = new Map(remoteThreads.map((t) => [`${t.hostId}:${t.threadId}`, t]));
    for (const card of doc.querySelectorAll<HTMLElement>(
      `[data-avatar-overlay-native-surface-id^="activity-"]:not([${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}])`,
    )) {
      if (card.getAttribute("data-avatar-overlay-hit-region") !== "activity-pill")
        card.setAttribute("data-avatar-overlay-hit-region", "activity-pill");
      const titleEl =
        card.querySelector<HTMLElement>(".truncate") ??
        card.querySelector<HTMLElement>("[data-avatar-overlay-activity-content] span");
      if (titleEl && titleEl.getAttribute(AVATAR_OVERLAY_NATIVE_TITLE_ATTR) !== "true")
        titleEl.setAttribute(AVATAR_OVERLAY_NATIVE_TITLE_ATTR, "true");
      const parsed = parseNativeActivitySurfaceId(
        card.getAttribute("data-avatar-overlay-native-surface-id") ?? "",
      );
      const matched = parsed ? byKey.get(`${parsed.hostId}:${parsed.threadId}`) : undefined;
      if (!parsed || !matched) continue;
      matchedKeys.add(`${parsed.hostId}:${parsed.threadId}`);
      const agent = matched.agent ?? "codex";
      const plugin =
        (matched.plugin as HarnessPluginDescriptor | undefined) ?? pluginMap.get(agent);
      const sig = iconSignature(agent, plugin);
      let badge = card.querySelector<HTMLElement>(`[${AVATAR_OVERLAY_NATIVE_ICON_ATTR}]`);
      if (!badge) {
        badge = doc.createElement("span");
        badge.setAttribute(AVATAR_OVERLAY_NATIVE_ICON_ATTR, "true");
        (titleEl?.parentElement && titleEl.parentElement !== card
          ? titleEl.parentElement
          : card
        ).prepend(badge);
      }
      if (badge.getAttribute("data-icon-signature") !== sig) {
        badge.setAttribute("data-icon-signature", sig);
        badge.replaceChildren(createRendererAgentIcon(agent, 14, doc, plugin));
      }
    }

    const unmatched = remoteThreads.filter((t) => !matchedKeys.has(`${t.hostId}:${t.threadId}`));
    const anchorParent =
      [
        "notification-stack-backing-layout",
        "notification-stack-visible-layout",
        "notification-tray-list",
        "notification-tray",
      ]
        .map((k) => doc.querySelector<HTMLElement>(`[data-avatar-overlay-size="${k}"]`))
        .find(Boolean) ??
      doc.querySelector<HTMLElement>(
        `[data-avatar-overlay-native-surface-id^="activity-"]:not([${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}])`,
      )?.parentElement ??
      null;

    let listEl = doc.querySelector<HTMLElement>(`[${AVATAR_OVERLAY_REMOTE_LIST_ATTR}]`);
    if (unmatched.length === 0 || !anchorParent) {
      listEl?.remove();
      return;
    }

    unhideElementAndAncestors(anchorParent);
    if (!listEl) {
      listEl = doc.createElement("div");
      listEl.setAttribute(AVATAR_OVERLAY_REMOTE_LIST_ATTR, "true");
      anchorParent.appendChild(listEl);
    } else if (listEl.parentElement !== anchorParent) {
      anchorParent.appendChild(listEl);
    }

    const signature = JSON.stringify(
      unmatched.map((t) => ({
        ...t,
        resolvedPlugin: t.plugin ?? (t.agent ? pluginMap.get(t.agent) : undefined) ?? null,
      })),
    );
    if (listEl.getAttribute("data-signature") === signature) {
      return;
    }
    listEl.setAttribute("data-signature", signature);
    listEl.replaceChildren();

    unmatched.forEach((thread) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "Material-oi9n4Q activityPill-s8lFCN";
      btn.setAttribute(AVATAR_OVERLAY_REMOTE_ITEM_ATTR, `${thread.hostId}:${thread.threadId}`);
      btn.setAttribute("data-avatar-overlay-hit-region", "activity-pill");
      btn.setAttribute("data-avatar-overlay-material", "css");
      btn.setAttribute("data-avatar-overlay-native-corner-radius", "28");
      btn.setAttribute(
        "data-avatar-overlay-native-surface-id",
        thread.hostId === "local"
          ? `activity-local:local:${thread.threadId}`
          : `activity-remote-host:${thread.hostId}:${thread.threadId}`,
      );

      const agent = thread.agent ?? "codex";
      const plugin = (thread.plugin as HarnessPluginDescriptor | undefined) ?? pluginMap.get(agent);
      const iconSpan = doc.createElement("span");
      iconSpan.setAttribute("data-remote-agent-icon", agent);
      iconSpan.appendChild(createRendererAgentIcon(agent, 14, doc, plugin));
      btn.appendChild(iconSpan);

      if (thread.hostId !== "local") {
        const hostBadge = doc.createElement("span");
        hostBadge.setAttribute("data-remote-host-badge", "true");
        hostBadge.textContent = `[${thread.hostLabel ?? thread.hostId}]`;
        btn.appendChild(hostBadge);
      }

      const titleSpan = doc.createElement("span");
      titleSpan.className = "truncate";
      titleSpan.setAttribute("data-remote-title", "true");
      titleSpan.textContent = thread.title;
      if (thread.preview) {
        titleSpan.title = `${thread.title}\n\n${thread.preview}`;
      }
      btn.appendChild(titleSpan);

      const dot = doc.createElement("span");
      dot.setAttribute("data-remote-status", thread.status);
      btn.appendChild(dot);

      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        requestPetsOpenThreadInMainWindow(
          { hostId: thread.hostId, threadId: thread.threadId },
          readStorage(),
        );
      });

      listEl.appendChild(btn);
    });
  };

  const renderComposerAgentPill = (
    enabledAgentsSet: ReadonlySet<RendererAgent>,
    pluginMap: ReadonlyMap<string, HarnessPluginDescriptor>,
  ): void => {
    const composer = doc.querySelector<HTMLElement>(
      '[data-avatar-overlay-native-surface-id="composer"]',
    );
    if (!composer) {
      closeAgentMenu?.();
      return;
    }
    if (composer.getAttribute("data-avatar-overlay-hit-region") !== "notification-composer") {
      composer.setAttribute("data-avatar-overlay-hit-region", "notification-composer");
    }
    unhideElementAndAncestors(composer);

    const storage = readStorage();
    const currentAgent = readNewThreadAgentPreference(enabledAgentsSet, storage) ?? "codex";
    const currentPlugin = pluginMap.get(currentAgent);
    const pillSig = iconSignature(currentAgent, currentPlugin);

    let pill = composer.querySelector<HTMLButtonElement>(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`);
    if (!pill) {
      const createdPill = doc.createElement("button");
      createdPill.type = "button";
      createdPill.setAttribute(AVATAR_OVERLAY_AGENT_PILL_ATTR, "true");
      createdPill.setAttribute("data-avatar-overlay-hit-region", "notification-composer");
      createdPill.className = "codexhost-trigger-chip no-drag";
      createdPill.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (closeAgentMenu) {
          closeAgentMenu();
          return;
        }
        openAgentPickerMenu(composer, createdPill);
      });
      const footerRow =
        composer.querySelector<HTMLElement>(".flex.items-center.justify-between") ??
        composer.querySelector<HTMLElement>("form") ??
        composer;
      footerRow.prepend(createdPill);
      pill = createdPill;
    }

    if (
      pill.getAttribute("data-agent") !== currentAgent ||
      pill.getAttribute("data-icon-signature") !== pillSig
    ) {
      pill.setAttribute("data-agent", currentAgent);
      pill.setAttribute("data-icon-signature", pillSig);
      pill.replaceChildren();
      pill.appendChild(createRendererAgentIcon(currentAgent, 13, doc, currentPlugin));
      const label = doc.createElement("span");
      label.textContent = rendererAgentLabel(currentAgent, currentPlugin);
      const caret = doc.createElement("span");
      caret.textContent = "▾";
      caret.style.opacity = "0.65";
      pill.append(label, caret);
    }
  };

  const openAgentPickerMenu = (composer: HTMLElement, anchor: HTMLElement): void => {
    closeAgentMenu?.();
    const { enabledAgents, enabledAgentsSet, pluginMap } = resolveCatalogState();
    const storage = readStorage();
    const selectedAgent = readNewThreadAgentPreference(enabledAgentsSet, storage) ?? "codex";

    const menu = doc.createElement("div");
    menu.className = "no-drag";
    menu.setAttribute(AVATAR_OVERLAY_AGENT_MENU_ATTR, "true");
    menu.setAttribute("data-avatar-overlay-hit-region", "notification-composer");
    menu.setAttribute("data-avatar-overlay-native-surface-id", "composer-agent-menu");
    menu.setAttribute("role", "menu");

    for (const agent of enabledAgents) {
      const plugin = pluginMap.get(agent);
      const item = doc.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("data-agent-option", agent);
      item.setAttribute("data-selected", agent === selectedAgent ? "true" : "false");
      item.appendChild(createRendererAgentIcon(agent, 13, doc, plugin));
      const text = doc.createElement("span");
      text.textContent = rendererAgentLabel(agent, plugin);
      item.appendChild(text);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        writeNewThreadAgentPreference(agent, readStorage());
        closeAgentMenu?.();
        refresh();
      });
      menu.appendChild(item);
    }

    doc.documentElement?.setAttribute(AVATAR_OVERLAY_MENU_OPEN_ATTR, "true");
    composer.appendChild(menu);
    const over200 = composer.getBoundingClientRect().top > 200;
    menu.style.bottom = over200 ? "calc(100% + 6px)" : "auto";
    menu.style.top = over200 ? "auto" : "calc(100% + 6px)";

    const onOutside = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (
        target &&
        typeof menu.contains === "function" &&
        (menu.contains(target) || anchor.contains(target))
      ) {
        return;
      }
      closeAgentMenu?.();
    };
    doc.addEventListener("mousedown", onOutside, true);
    closeAgentMenu = () => {
      doc.removeEventListener("mousedown", onOutside, true);
      doc.documentElement?.removeAttribute(AVATAR_OVERLAY_MENU_OPEN_ATTR);
      menu.remove();
      closeAgentMenu = null;
    };
  };

  const refresh = (): void => {
    if (disposed || isRefreshing) return;
    isRefreshing = true;
    try {
      const remoteThreads = readPetsRemoteThreads(readStorage());
      const { enabledAgentsSet, pluginMap } = resolveCatalogState(remoteThreads);
      reconcileActivityStackViewport();
      reconcileRemoteThreadsList(remoteThreads, pluginMap);
      renderComposerAgentPill(enabledAgentsSet, pluginMap);
    } finally {
      isRefreshing = false;
    }
  };

  const onStorage = (event: StorageEvent): void => {
    if (
      !event.key ||
      event.key === PETS_REMOTE_THREADS_STORAGE_KEY ||
      event.key === PETS_HARNESS_CATALOG_STORAGE_KEY ||
      event.key === RENDERER_NEW_THREAD_PREFERENCE_KEY
    ) {
      refresh();
    }
  };

  win.addEventListener("storage", onStorage);

  const observer =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          refresh();
        })
      : null;
  if (observer && doc.documentElement) {
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  refresh();

  const handle: RendererAvatarOverlayHandle = {
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (winState[ACTIVE_HANDLE_SYMBOL] === handle) winState[ACTIVE_HANDLE_SYMBOL] = undefined;
      if (
        messagePortProto &&
        originalPostMessage &&
        messagePortProto.postMessage === patchedPostMessage
      ) {
        messagePortProto.postMessage = originalPostMessage;
      }
      closeAgentMenu?.();
      observer?.disconnect();
      win.removeEventListener("storage", onStorage);
      doc.documentElement?.removeAttribute(AVATAR_OVERLAY_ROOT_ATTR);
      doc.documentElement?.removeAttribute(AVATAR_OVERLAY_MENU_OPEN_ATTR);
      doc.getElementById(AVATAR_OVERLAY_STYLE_ID)?.remove();
      for (const el of doc.querySelectorAll(
        `[${AVATAR_OVERLAY_AGENT_PILL_ATTR}], [${AVATAR_OVERLAY_AGENT_MENU_ATTR}], [${AVATAR_OVERLAY_REMOTE_LIST_ATTR}], [${AVATAR_OVERLAY_NATIVE_ICON_ATTR}]`,
      )) {
        el.remove();
      }
    },
  };
  winState[ACTIVE_HANDLE_SYMBOL] = handle;
  return handle;
}
