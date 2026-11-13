import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";
import { DEFAULT_RENDERER_AGENTS, type RendererAgent } from "./agent-selection-state.js";
import { findReactProps } from "./react-fiber-props.js";
import { createRendererAgentIcon, rendererAgentLabel } from "./renderer-agent-icon.js";
import {
  PETS_QUICK_CHAT_TARGET_STORAGE_KEY,
  PETS_REMOTE_PROJECTS_STORAGE_KEY,
  installPetsQuickChatTargetHook,
  readPetsQuickChatTarget,
  readPetsRemoteProjects,
  writePetsQuickChatTarget,
  type PetsRemoteProject,
} from "./renderer-pets-quick-chat-target.js";
import { createRemoteHostGlobe } from "./renderer-sidebar-remote-projects.js";

export const AVATAR_OVERLAY_STYLE_ID = "codexhost-avatar-overlay-styles";
export const AVATAR_OVERLAY_ROOT_ATTR = "data-codexhost-avatar-overlay";
export const AVATAR_OVERLAY_AGENT_PILL_ATTR = "data-codexhost-pets-agent-pill";
export const AVATAR_OVERLAY_AGENT_MENU_ATTR = "data-codexhost-pets-agent-menu";
/** Set on native activity cards of external Harness threads; CSS draws the Agent icon from it. */
export const AVATAR_OVERLAY_CARD_AGENT_ATTR = "data-codexhost-pets-agent";
export const AVATAR_OVERLAY_ICON_STYLE_ID = "codexhost-avatar-overlay-agent-icons";

export const PETS_HARNESS_CATALOG_STORAGE_KEY = "codexhost.pets-harness-catalog.v1";
/** `hostId:threadId` → Agent for external Harness threads, published by the main window. */
export const PETS_THREAD_AGENTS_STORAGE_KEY = "codexhost.pets-thread-agents.v1";
/** The Pet's own Quick Chat Agent; the main window keeps its new-thread default in Host. */
export const PETS_QUICK_CHAT_AGENT_STORAGE_KEY = "codexhost.pets-quick-chat-agent.v1";
export const PETS_STACK_MAX_HEIGHT_STORAGE_KEY = "codexhost.pets-stack-max-height.v1";
export const DEFAULT_PETS_STACK_MAX_HEIGHT_PX = 600;
export const PETS_STACK_MAX_HEIGHT_MIN_PX = 200;
export const PETS_STACK_MAX_HEIGHT_MAX_PX = 1600;
/** Native activity card height; the stack never shrinks below one card. */
const NATIVE_STACK_MIN_HEIGHT_PX = 56;
/** Mascot, its control row and the tray margins share the work area with the stack. */
const PET_CHROME_HEIGHT_PX = 240;

export type PetsHarnessCatalogPlugin = Pick<
  HarnessPluginDescriptor,
  "id" | "name" | "icon" | "iconStyle"
>;
export interface PetsHarnessCatalog {
  readonly enabledAgents: readonly RendererAgent[];
  readonly plugins: readonly PetsHarnessCatalogPlugin[];
}

export interface InstallRendererAvatarOverlayOptions {
  readonly document?: Document;
  readonly window?: Window;
}

export interface RendererAvatarOverlayHandle {
  readonly refresh: () => void;
  readonly dispose: () => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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

export function readPetsThreadAgents(
  storage?: Pick<Storage, "getItem"> | null,
): ReadonlyMap<string, RendererAgent> {
  const agents = new Map<string, RendererAgent>();
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(PETS_THREAD_AGENTS_STORAGE_KEY) ?? "");
    if (isRecord(parsed))
      for (const [key, agent] of Object.entries(parsed))
        if (typeof agent === "string" && agent && agent !== "codex")
          agents.set(key, agent as RendererAgent);
  } catch {}
  return agents;
}

export function writePetsThreadAgents(
  agents: Readonly<Record<string, string>>,
  storage?: Pick<Storage, "getItem" | "setItem"> | null,
): void {
  try {
    const next = JSON.stringify(agents);
    if (storage?.getItem(PETS_THREAD_AGENTS_STORAGE_KEY) !== next)
      storage?.setItem(PETS_THREAD_AGENTS_STORAGE_KEY, next);
  } catch {}
}

export function readPetsStackMaxHeightPreference(
  storage?: Pick<Storage, "getItem"> | null,
): number {
  try {
    const value = Number(storage?.getItem(PETS_STACK_MAX_HEIGHT_STORAGE_KEY) ?? "");
    if (Number.isFinite(value) && value > 0)
      return Math.min(
        PETS_STACK_MAX_HEIGHT_MAX_PX,
        Math.max(PETS_STACK_MAX_HEIGHT_MIN_PX, Math.round(value)),
      );
  } catch {}
  return DEFAULT_PETS_STACK_MAX_HEIGHT_PX;
}

export function writePetsStackMaxHeightPreference(
  value: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    storage?.setItem(PETS_STACK_MAX_HEIGHT_STORAGE_KEY, String(Math.round(value)));
  } catch {}
}

/**
 * The Pet activity stack height that replaces Codex's built-in limit: the preference, capped so
 * the stack and the mascot still fit the work area (`quickChat.workArea` when Quick Chat is
 * presented, the screen otherwise).
 */
export function resolvePetsStackMaxHeight(
  preference: number,
  quickChat: unknown,
  screenHeight: number,
): number {
  const workArea = isRecord(quickChat) && isRecord(quickChat.workArea) ? quickChat.workArea : null;
  const available =
    workArea && typeof workArea.height === "number" ? workArea.height : screenHeight;
  return Math.max(
    NATIVE_STACK_MIN_HEIGHT_PX,
    Math.min(preference, available - PET_CHROME_HEIGHT_PX),
  );
}

const STACK_HEIGHT_HOOK = "__codexhostPetsStackMaxHeight";
const LAYOUT_CHANGED_MESSAGE = "avatar-overlay-layout-changed";
const STACK_HOOK_HANDLE_SYMBOL = Symbol.for("codexhost.petsStackHeightHook");

/**
 * Serves the stack height to the rewritten Codex Pet chunk (see desktop-control's
 * avatar-overlay-stack-height). Install before the Pet renders. Codex derives the height only
 * when a layout arrives, so a preference change replays the latest layout message.
 */
export function installPetsStackHeightHook(win: Window): () => void {
  const handles = win as unknown as Record<symbol, (() => void) | undefined>;
  handles[STACK_HOOK_HANDLE_SYMBOL]?.();
  const readStorage = (): Storage | null => {
    try {
      return win.localStorage ?? null;
    } catch {
      return null;
    }
  };
  const state = win as unknown as Record<string, unknown>;
  state[STACK_HEIGHT_HOOK] = (quickChat: unknown) =>
    resolvePetsStackMaxHeight(
      readPetsStackMaxHeightPreference(readStorage()),
      quickChat,
      win.screen?.availHeight ?? 0,
    );
  let lastLayout: unknown = null;
  const onMessage = (event: MessageEvent): void => {
    if (isRecord(event.data) && event.data.type === LAYOUT_CHANGED_MESSAGE) lastLayout = event.data;
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === PETS_STACK_MAX_HEIGHT_STORAGE_KEY && lastLayout)
      win.postMessage(lastLayout, "*");
  };
  win.addEventListener("message", onMessage);
  win.addEventListener("storage", onStorage);
  const dispose = (): void => {
    if (handles[STACK_HOOK_HANDLE_SYMBOL] === dispose)
      handles[STACK_HOOK_HANDLE_SYMBOL] = undefined;
    Reflect.deleteProperty(state, STACK_HEIGHT_HOOK);
    win.removeEventListener("message", onMessage);
    win.removeEventListener("storage", onStorage);
  };
  handles[STACK_HOOK_HANDLE_SYMBOL] = dispose;
  return dispose;
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
  storage?: Pick<Storage, "getItem" | "setItem"> | null,
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
    const next = JSON.stringify({ enabledAgents, plugins });
    // The catalog carries every plugin icon; rewriting it unchanged would wake the Pet for nothing.
    if (storage?.getItem(PETS_HARNESS_CATALOG_STORAGE_KEY) !== next)
      storage?.setItem(PETS_HARNESS_CATALOG_STORAGE_KEY, next);
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

/**
 * Pet overlay additions. Native cards, stacking, gestures and animations are left untouched:
 * external Harness cards only gain an attribute that the icon stylesheet keys on, and the Agent
 * picker floats above the composing Quick Chat bar in the native above-composer portal.
 */
export function buildAvatarOverlayCss(): string {
  return `
[${AVATAR_OVERLAY_CARD_AGENT_ATTR}] [data-avatar-overlay-activity-text="title"]::before {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-inline-end: 6px;
  vertical-align: -2px;
  background-position: center;
  background-size: contain;
  background-repeat: no-repeat;
}
[${AVATAR_OVERLAY_AGENT_PILL_ATTR}] {
  position: absolute;
  left: 0;
  bottom: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
  border-radius: 14px;
  background: var(--avatar-overlay-material-background, #ffffffe6);
  box-shadow: inset 0 1px 1px #fff9, inset 0 -1px 2px #fff3;
  pointer-events: auto;
  color: inherit;
  font: inherit;
  font-size: var(--text-xs, 13px);
  cursor: pointer;
}
[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]:hover { color: var(--color-token-foreground, currentColor); }
[${AVATAR_OVERLAY_AGENT_PILL_ATTR}] > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[${AVATAR_OVERLAY_AGENT_PILL_ATTR}] :is(svg, img),
[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] :is(svg, img) { width: 14px; height: 14px; display: block; flex-shrink: 0; }
[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] {
  position: absolute;
  left: 0;
  bottom: 44px;
  display: flex;
  flex-direction: column;
  min-width: 220px;
  max-width: 320px;
  max-height: 260px;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
  border-radius: 16px;
  background: var(--avatar-overlay-material-background, #ffffffe6);
  box-shadow: inset 0 1px 1px #fff9, var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.16));
  font-size: var(--text-sm, 14px);
  pointer-events: auto;
}
[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] small {
  margin-inline-start: auto;
  padding-inline-start: 12px;
  color: var(--color-token-text-tertiary, currentColor);
  font-size: var(--text-xs, 12px);
  white-space: nowrap;
}
[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] [role="separator"] {
  flex-shrink: 0;
  height: 1px;
  margin: 4px 6px;
  background: color-mix(in srgb, var(--color-border) 60%, transparent);
}
[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] button > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.codexhost-pets-globe { width: 12px !important; height: 12px !important; display: block; flex-shrink: 0; }
[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] button:hover,
[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] button[aria-checked="true"] { background: var(--color-token-list-hover-background, rgba(0, 0, 0, 0.05)); }
`.trim();
}

export function ensureAvatarOverlayStyles(doc: Document): void {
  let style = doc.getElementById(AVATAR_OVERLAY_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = AVATAR_OVERLAY_STYLE_ID;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  style.textContent = buildAvatarOverlayCss();
}

/** CSS background declarations that reproduce a rendered Agent icon on a pseudo-element. */
function agentIconBackground(icon: Element): string | null {
  if (icon.localName === "svg") {
    icon.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const svg = new XMLSerializer().serializeToString(icon);
    return `background-image: url("data:image/svg+xml,${encodeURIComponent(svg)}");`;
  }
  if (icon.localName !== "img") return null;
  const image = icon as HTMLImageElement;
  const declarations = [`background-image: url(${JSON.stringify(image.src)});`];
  if (image.style.background) declarations.push(`background-color: ${image.style.background};`);
  if (image.style.borderRadius) declarations.push(`border-radius: ${image.style.borderRadius};`);
  if (image.style.padding) {
    declarations.push("box-sizing: border-box;", `padding: ${image.style.padding};`);
    declarations.push("background-origin: content-box;", "background-clip: padding-box;");
  }
  return declarations.join(" ");
}

const ACTIVE_HANDLE_SYMBOL = Symbol.for("codexhost.avatarOverlayActiveHandle");
const OWN_NODE_SELECTOR = `[${AVATAR_OVERLAY_AGENT_PILL_ATTR}], [${AVATAR_OVERLAY_AGENT_MENU_ATTR}]`;

/**
 * A card started from Quick Chat keeps its `client-new-thread:` id after the thread exists; the
 * native notification behind it names the thread in `notificationPreferenceId`. Maps card id to
 * that thread id, read from the stack component's `notifications` prop.
 */
export function readNativeActivityThreadIds(card: Element): Map<string, string> {
  const ids = new Map<string, string>();
  const notifications = findReactProps(card, (props) =>
    Array.isArray(props.notifications) ? (props.notifications as unknown[]) : null,
  );
  for (const notification of notifications ?? []) {
    if (!isRecord(notification)) continue;
    const { id, notificationPreferenceId } = notification;
    if (typeof id === "string" && typeof notificationPreferenceId === "string")
      ids.set(id, notificationPreferenceId);
  }
  return ids;
}

/** Native Pet activity ids are `local:local:<threadId>` or `remote-host:<hostId>:<threadId>`. */
export function parseNativeActivityId(id: string): { hostId: string; threadId: string } | null {
  if (id.startsWith("local:local:")) {
    const threadId = id.slice("local:local:".length);
    return threadId ? { hostId: "local", threadId } : null;
  }
  if (!id.startsWith("remote-host:")) return null;
  const rest = id.slice("remote-host:".length);
  const separator = rest.lastIndexOf(":");
  return separator > 0 && separator < rest.length - 1
    ? { hostId: rest.slice(0, separator), threadId: rest.slice(separator + 1) }
    : null;
}

export function installRendererAvatarOverlay(
  options: InstallRendererAvatarOverlayOptions = {},
): RendererAvatarOverlayHandle {
  const doc = options.document ?? document;
  const win = options.window ?? doc.defaultView ?? window;
  const winState = win as unknown as Record<symbol, RendererAvatarOverlayHandle | undefined>;
  winState[ACTIVE_HANDLE_SYMBOL]?.dispose();

  doc.documentElement.setAttribute(AVATAR_OVERLAY_ROOT_ATTR, "true");
  ensureAvatarOverlayStyles(doc);

  let disposed = false;
  let closeAgentMenu: (() => void) | null = null;

  const readStorage = (): Storage | null => {
    try {
      return win.localStorage ?? null;
    } catch {
      return null;
    }
  };

  // Native mutations refresh often; parse the catalog (which carries every plugin icon) only
  // when its stored text changes.
  let catalogRaw: string | null | undefined;
  let catalogState: {
    enabledAgents: readonly RendererAgent[];
    pluginMap: ReadonlyMap<string, HarnessPluginDescriptor>;
  } = { enabledAgents: DEFAULT_RENDERER_AGENTS, pluginMap: new Map() };
  const resolveCatalogState = () => {
    const storage = readStorage();
    const raw = storage?.getItem(PETS_HARNESS_CATALOG_STORAGE_KEY) ?? null;
    if (raw === catalogRaw) return catalogState;
    catalogRaw = raw;
    const stored = readPetsHarnessCatalog(storage);
    catalogState = {
      enabledAgents: stored?.enabledAgents ?? DEFAULT_RENDERER_AGENTS,
      pluginMap: new Map((stored?.plugins ?? []).map((p) => [p.id, p as HarnessPluginDescriptor])),
    };
    renderAgentIconStyles(catalogState.pluginMap);
    return catalogState;
  };

  let remoteProjectsRaw: string | null | undefined;
  let remoteProjects: PetsRemoteProject[] = [];
  const resolveRemoteProjects = (): PetsRemoteProject[] => {
    const storage = readStorage();
    const raw = storage?.getItem(PETS_REMOTE_PROJECTS_STORAGE_KEY) ?? null;
    if (raw !== remoteProjectsRaw) {
      remoteProjectsRaw = raw;
      remoteProjects = readPetsRemoteProjects(storage);
    }
    return remoteProjects;
  };
  /** The remote project Quick Chat starts in, or `null` for this machine. */
  const selectedTarget = (): PetsRemoteProject | null =>
    readPetsQuickChatTarget(readStorage(), resolveRemoteProjects());
  /** Agents the selected location can run: every enabled Agent here, the host's installed ones remotely. */
  const availableAgents = (target = selectedTarget()): readonly RendererAgent[] => {
    const { enabledAgents } = resolveCatalogState();
    return target
      ? enabledAgents.filter((agent) => agent === "codex" || target.agents.includes(agent))
      : enabledAgents;
  };
  const selectedAgent = (): RendererAgent => {
    const stored = readStorage()?.getItem(PETS_QUICK_CHAT_AGENT_STORAGE_KEY);
    return stored && availableAgents().includes(stored as RendererAgent)
      ? (stored as RendererAgent)
      : "codex";
  };
  const disposeTargetHook = installPetsQuickChatTargetHook(win, selectedTarget);
  const isChinese = (): boolean =>
    (doc.documentElement.lang || win.navigator?.language || "").toLowerCase().startsWith("zh");

  // Quick Chat creates its thread through a capnweb `startConversation` frame; route it to the
  // selected external Harness by rewriting the model route in that frame only.
  const messagePortProto = (win as unknown as { MessagePort?: { prototype: MessagePort } })
    .MessagePort?.prototype;
  const originalPostMessage = messagePortProto?.postMessage;
  let patchedPostMessage: MessagePort["postMessage"] | null = null;
  if (messagePortProto && originalPostMessage) {
    patchedPostMessage = function (this: MessagePort, message: unknown, ...rest: unknown[]): void {
      let next = message;
      try {
        next = rewriteStartConversationPostMessagePayload(message, selectedAgent());
      } catch {
        next = message;
      }
      (originalPostMessage as (this: MessagePort, ...args: unknown[]) => void).call(
        this,
        next,
        ...rest,
      );
    } as MessagePort["postMessage"];
    messagePortProto.postMessage = patchedPostMessage;
  }

  /** One rule per external Agent, so cards of an Agent without a known icon get no blank gap. */
  const renderAgentIconStyles = (pluginMap: ReadonlyMap<string, HarnessPluginDescriptor>) => {
    const rules: string[] = [];
    for (const [agent, plugin] of pluginMap) {
      if (agent === "codex") continue;
      const background = agentIconBackground(createRendererAgentIcon(agent, 14, doc, plugin));
      if (!background) continue;
      rules.push(
        `[${AVATAR_OVERLAY_CARD_AGENT_ATTR}=${JSON.stringify(agent)}] [data-avatar-overlay-activity-text="title"]::before { content: ""; ${background} }`,
      );
    }
    let style = doc.getElementById(AVATAR_OVERLAY_ICON_STYLE_ID);
    if (!style) {
      style = doc.createElement("style");
      style.id = AVATAR_OVERLAY_ICON_STYLE_ID;
      (doc.head ?? doc.documentElement).appendChild(style);
    }
    const css = rules.join("\n");
    if (style.textContent !== css) style.textContent = css;
  };

  const tagNativeCards = (): void => {
    const agents = readPetsThreadAgents(readStorage());
    const cards = doc.querySelectorAll<HTMLElement>("[data-avatar-overlay-activity-stack-item]");
    const threadIds = cards[0] ? readNativeActivityThreadIds(cards[0]) : new Map<string, string>();
    for (const card of cards) {
      const id = card.getAttribute("data-avatar-overlay-activity-stack-item") ?? "";
      const parsed = parseNativeActivityId(threadIds.get(id) ?? id);
      const agent = parsed ? agents.get(`${parsed.hostId}:${parsed.threadId}`) : undefined;
      if (!agent) card.removeAttribute(AVATAR_OVERLAY_CARD_AGENT_ATTR);
      else if (card.getAttribute(AVATAR_OVERLAY_CARD_AGENT_ATTR) !== agent)
        card.setAttribute(AVATAR_OVERLAY_CARD_AGENT_ATTR, agent);
    }
  };

  // Native Quick Chat leaves the composing state once its editor blurs, so the picker must not
  // take focus.
  const keepComposerFocus = (event: MouseEvent): void => event.preventDefault();

  const openAgentMenu = (pill: HTMLElement): void => {
    closeAgentMenu?.();
    const portal = doc.querySelector<HTMLElement>("[data-above-composer-portal]");
    if (!portal) return;
    const { pluginMap } = resolveCatalogState();
    const current = selectedAgent();
    const target = selectedTarget();

    const menu = doc.createElement("div");
    menu.setAttribute(AVATAR_OVERLAY_AGENT_MENU_ATTR, "true");
    menu.setAttribute("data-avatar-overlay-hit-region", "notification-composer");
    menu.setAttribute("role", "menu");
    menu.addEventListener("mousedown", keepComposerFocus);
    const projects = resolveRemoteProjects();
    if (projects.length > 0) {
      const locations: Array<PetsRemoteProject | null> = [null, ...projects];
      for (const project of locations) {
        const option = doc.createElement("button");
        option.type = "button";
        option.setAttribute("role", "menuitemradio");
        option.setAttribute(
          "data-location-option",
          project ? `${project.hostId}|${project.projectId}` : "local",
        );
        const checked = project
          ? target?.hostId === project.hostId && target.projectId === project.projectId
          : target === null;
        option.setAttribute("aria-checked", checked ? "true" : "false");
        const label = doc.createElement("span");
        label.textContent = project ? project.label : isChinese() ? "本机" : "This Mac";
        if (project) {
          const host = doc.createElement("small");
          host.textContent = project.hostLabel;
          option.title = project.path;
          option.append(
            createRemoteHostGlobe(doc, project.hostColor, "codexhost-pets-globe"),
            label,
            host,
          );
        } else {
          option.append(label);
        }
        option.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          writePetsQuickChatTarget(project, readStorage());
          // The Agent list depends on the location; reopen the menu so it can be picked next.
          openAgentMenu(pill);
          scheduleRefresh();
        });
        menu.appendChild(option);
      }
      const separator = doc.createElement("div");
      separator.setAttribute("role", "separator");
      menu.appendChild(separator);
    }
    for (const agent of availableAgents(target)) {
      const plugin = pluginMap.get(agent);
      const option = doc.createElement("button");
      option.type = "button";
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("data-agent-option", agent);
      option.setAttribute("aria-checked", agent === current ? "true" : "false");
      const label = doc.createElement("span");
      label.textContent = rendererAgentLabel(agent, plugin);
      option.append(createRendererAgentIcon(agent, 14, doc, plugin), label);
      option.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          readStorage()?.setItem(PETS_QUICK_CHAT_AGENT_STORAGE_KEY, agent);
        } catch {
          // Storage unavailable: the selection lasts until the menu closes.
        }
        closeAgentMenu?.();
        scheduleRefresh();
      });
      menu.appendChild(option);
    }
    portal.appendChild(menu);
    pill.setAttribute("aria-expanded", "true");

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && (menu.contains(target) || pill.contains(target))) return;
      closeAgentMenu?.();
    };
    doc.addEventListener("pointerdown", onPointerDown, true);
    closeAgentMenu = () => {
      doc.removeEventListener("pointerdown", onPointerDown, true);
      pill.setAttribute("aria-expanded", "false");
      menu.remove();
      closeAgentMenu = null;
    };
  };

  const renderAgentPill = (pluginMap: ReadonlyMap<string, HarnessPluginDescriptor>): void => {
    // Only the composing bar starts a new thread; the minimized and collapsed bars keep their
    // native controls only.
    const composing =
      doc
        .querySelector("[data-quick-chat-presentation]")
        ?.getAttribute("data-quick-chat-presentation") === "composing";
    const portal = composing
      ? doc.querySelector<HTMLElement>("[data-above-composer-portal]")
      : null;
    let pill = doc.querySelector<HTMLButtonElement>(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`);
    if (!portal) {
      closeAgentMenu?.();
      pill?.remove();
      return;
    }
    if (!pill) {
      pill = doc.createElement("button");
      pill.type = "button";
      pill.setAttribute(AVATAR_OVERLAY_AGENT_PILL_ATTR, "true");
      pill.setAttribute("aria-haspopup", "menu");
      pill.setAttribute("aria-expanded", "false");
      pill.className = "no-drag";
      pill.addEventListener("mousedown", keepComposerFocus);
      const ownPill = pill;
      pill.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (closeAgentMenu) closeAgentMenu();
        else openAgentMenu(ownPill);
      });
    }
    if (pill.parentElement !== portal) portal.prepend(pill);

    const agent = selectedAgent();
    const plugin = pluginMap.get(agent);
    const target = selectedTarget();
    const signature = JSON.stringify([agent, plugin?.icon ?? "", target]);
    if (pill.getAttribute("data-agent") === signature) return;
    pill.setAttribute("data-agent", signature);
    const label = doc.createElement("span");
    label.textContent = rendererAgentLabel(agent, plugin);
    pill.title = target
      ? `${label.textContent} · ${target.label} (${target.hostLabel})`
      : label.textContent;
    pill.replaceChildren(createRendererAgentIcon(agent, 14, doc, plugin), label);
    if (target) {
      const project = doc.createElement("span");
      project.textContent = target.label;
      pill.append(createRemoteHostGlobe(doc, target.hostColor, "codexhost-pets-globe"), project);
    }
  };

  const refresh = (): void => {
    if (disposed) return;
    const { pluginMap } = resolveCatalogState();
    tagNativeCards();
    renderAgentPill(pluginMap);
  };

  // A timer rather than requestAnimationFrame: frames stall while the window is hidden or
  // occluded, but card icons and the picker must stay current in that state.
  let pendingTimer: number | null = null;
  const scheduleRefresh = (): void => {
    if (disposed || pendingTimer !== null) return;
    pendingTimer = win.setTimeout(() => {
      pendingTimer = null;
      refresh();
    }, 50);
  };

  const onStorage = (event: StorageEvent): void => {
    if (
      !event.key ||
      event.key === PETS_THREAD_AGENTS_STORAGE_KEY ||
      event.key === PETS_HARNESS_CATALOG_STORAGE_KEY ||
      event.key === PETS_QUICK_CHAT_AGENT_STORAGE_KEY ||
      event.key === PETS_QUICK_CHAT_TARGET_STORAGE_KEY ||
      event.key === PETS_REMOTE_PROJECTS_STORAGE_KEY
    )
      scheduleRefresh();
  };
  win.addEventListener("storage", onStorage);

  const isOwnMutation = (record: MutationRecord): boolean =>
    record.target instanceof Element && record.target.closest(OWN_NODE_SELECTOR) !== null;
  const observer = new MutationObserver((records) => {
    if (!records.every(isOwnMutation)) scheduleRefresh();
  });
  observer.observe(doc.body ?? doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-quick-chat-presentation"],
  });

  refresh();

  const handle: RendererAvatarOverlayHandle = {
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (pendingTimer !== null) win.clearTimeout(pendingTimer);
      if (winState[ACTIVE_HANDLE_SYMBOL] === handle) winState[ACTIVE_HANDLE_SYMBOL] = undefined;
      if (
        messagePortProto &&
        originalPostMessage &&
        messagePortProto.postMessage === patchedPostMessage
      )
        messagePortProto.postMessage = originalPostMessage;
      closeAgentMenu?.();
      disposeTargetHook();
      observer.disconnect();
      win.removeEventListener("storage", onStorage);
      doc.documentElement.removeAttribute(AVATAR_OVERLAY_ROOT_ATTR);
      doc.getElementById(AVATAR_OVERLAY_STYLE_ID)?.remove();
      doc.getElementById(AVATAR_OVERLAY_ICON_STYLE_ID)?.remove();
      for (const el of doc.querySelectorAll(OWN_NODE_SELECTOR)) el.remove();
      for (const card of doc.querySelectorAll(`[${AVATAR_OVERLAY_CARD_AGENT_ATTR}]`))
        card.removeAttribute(AVATAR_OVERLAY_CARD_AGENT_ATTR);
    },
  };
  winState[ACTIVE_HANDLE_SYMBOL] = handle;
  return handle;
}
