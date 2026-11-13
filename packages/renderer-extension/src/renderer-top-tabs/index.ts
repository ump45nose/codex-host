import {
  hostThreadIdSchema,
  type HarnessPluginDescriptor,
  type HostThreadId,
} from "@codexhost/shared-contracts";
import type { RendererAgent } from "../agent-selection-state.js";
import { createRendererAgentIcon } from "../renderer-agent-icon.js";
import {
  SIDEBAR_AGENT_ICON_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_SELECTOR,
  sidebarThreadAttributes,
  threadIdFromSidebarRowElement,
} from "../renderer-sidebar-agent-icons.js";
import type { RendererSidebarThreadTree } from "../renderer-sidebar-thread-tree.js";
import {
  createRemoteHostGlobe,
  readRemoteHostGlobeColors,
} from "../renderer-sidebar-remote-projects.js";
import {
  readTopTabsEnabledPreference,
  readTopTabsTwoRowsPreference,
  subscribeTopTabsPreference,
} from "./preference.js";
import { ensureTopTabsStyles } from "./style.js";

export const TOP_TABS_ROOT_ATTRIBUTE = "data-codexhost-top-tabs";
export const TOP_TAB_ATTRIBUTE = "data-codexhost-top-tab";
export const TOP_TABS_MORE_ATTRIBUTE = "data-codexhost-top-tabs-more";
export const TOP_TABS_MENU_ATTRIBUTE = "data-codexhost-top-tabs-menu";
export const TOP_TABS_COLUMNS = 5;

export type TopTabStatus = "waiting" | "failed" | "running" | "unread" | "idle";

const STATUS_PRIORITY: Readonly<Record<TopTabStatus, number>> = {
  waiting: 5,
  failed: 4,
  running: 3,
  unread: 2,
  idle: 1,
};

/** Codex Desktop renders a thread's attention state as `data-sidebar-indicator` on its sidebar row. */
const NATIVE_INDICATOR_STATUS: Readonly<Record<string, TopTabStatus>> = {
  working: "running",
  approval: "waiting",
  input: "waiting",
  error: "failed",
  unread: "unread",
};
const NATIVE_INDICATOR_ATTRIBUTE = "data-sidebar-indicator";
const NATIVE_SELECTED_ATTRIBUTE = "data-app-action-sidebar-thread-selected";
const NATIVE_TITLE_ATTRIBUTE = "data-app-action-sidebar-thread-title";
/** The trailing status glyph (spinner, dot) inside a native sidebar row. */
const NATIVE_INDICATOR_GLYPH_SELECTOR =
  '[data-hover-card-open-immediately] > span:has([data-loading-indicator], [role="status"], .rounded-full)';
const SIDEBAR_MIRROR_ATTRIBUTE = "data-codexhost-sidebar-thread-mirror";
const SIDEBAR_SCROLL_SELECTOR = "[data-app-action-sidebar-scroll]";
const ACTIVE_PAGE_ATTRIBUTE = "data-app-shell-active-page";

export interface SidebarThreadSnapshot {
  readonly hostId: string;
  readonly threadId: HostThreadId;
  readonly title: string;
  readonly status: TopTabStatus;
  readonly active: boolean;
  readonly agent: RendererAgent;
  readonly plugin?: HarnessPluginDescriptor;
  readonly rowElement: HTMLElement;
}

export interface InstallRendererTopTabsOptions {
  readonly document?: Document;
  readonly window?: Window;
  readonly tree?: Pick<RendererSidebarThreadTree, "rootThread"> | null;
  readonly getLocale?: () => string;
  readonly getThreadAgent?: (
    hostId: string,
    threadId: HostThreadId,
    fallbackAgent?: RendererAgent,
  ) => { agent: RendererAgent; plugin?: HarnessPluginDescriptor } | null;
  readonly getHostLabel?: (hostId: string) => string | null;
  readonly acknowledgedFailedKeys?: Set<string>;
  readonly onChange?: () => void;
}

export interface RendererTopTabsHandle {
  readonly refresh: () => void;
  readonly dispose: () => void;
}

const KNOWN_HOST_CASING: Readonly<Record<string, string>> = {
  macpro: "MacPro",
  macbookpro: "MacBookPro",
  macair: "MacAir",
  macbookair: "MacBookAir",
  macmini: "MacMini",
  macstudio: "MacStudio",
  nas: "NAS",
};

export function resolveShortHostLabel(hostId: string, customLabel?: string | null): string | null {
  const id = hostId.trim();
  const raw = (customLabel?.trim() || id)
    .replace(/^remote-ssh-[a-z-]+:/i, "")
    .replace(/^ssh:\/\//i, "")
    .replace(/^[^@]+@/, "");
  if (!id || id === "local" || !raw || raw === "local") return null;
  const ipv4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(raw);
  if (ipv4?.[1]) return ipv4[1];
  const base = (raw.replace(/:\d+$/, "").split(".")[0] ?? raw).trim() || id;
  return KNOWN_HOST_CASING[base.toLowerCase()] ?? base.slice(0, 16);
}

export function isUnreadOrActiveSessionStatus(
  status: TopTabStatus,
  key: string,
  acknowledgedFailedKeys: ReadonlySet<string>,
): boolean {
  if (status === "running" || status === "waiting" || status === "unread") return true;
  return status === "failed" && !acknowledgedFailedKeys.has(key);
}

export function rollupTopTabStatus(statuses: Iterable<TopTabStatus>): TopTabStatus {
  let best: TopTabStatus = "idle";
  for (const status of statuses) {
    if (STATUS_PRIORITY[status] > STATUS_PRIORITY[best]) best = status;
  }
  return best;
}

export function sidebarRowStatus(row: HTMLElement): TopTabStatus {
  return NATIVE_INDICATOR_STATUS[row.getAttribute(NATIVE_INDICATOR_ATTRIBUTE) ?? ""] ?? "idle";
}

function resolveThreadIdFromRow(row: HTMLElement): HostThreadId | null {
  const attrs = sidebarThreadAttributes(row);
  if (!attrs) return null;
  const raw =
    threadIdFromSidebarRowElement(row) ||
    (attrs.taskKey.startsWith(`${attrs.hostId}:`)
      ? attrs.taskKey.slice(attrs.hostId.length + 1)
      : attrs.taskKey);
  if (!raw || raw.startsWith("client-new-thread:")) return null;
  const parsed = hostThreadIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Reads every native sidebar thread row once, keyed by `${hostId}:${threadId}`. */
export function collectSidebarThreads(
  doc: Document,
  getThreadAgent?: InstallRendererTopTabsOptions["getThreadAgent"],
): Map<string, SidebarThreadSnapshot> {
  const map = new Map<string, SidebarThreadSnapshot>();
  for (const row of doc.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)) {
    if (row.hasAttribute(SIDEBAR_MIRROR_ATTRIBUTE)) continue;
    const hostId = sidebarThreadAttributes(row)?.hostId;
    const threadId = hostId ? resolveThreadIdFromRow(row) : null;
    if (!hostId || !threadId) continue;
    const key = `${hostId}:${threadId}`;
    if (map.has(key)) continue;
    const rowAgent = (row
      .querySelector<HTMLElement>(`[${SIDEBAR_AGENT_ICON_ATTRIBUTE}]`)
      ?.getAttribute(SIDEBAR_AGENT_ICON_ATTRIBUTE)
      ?.trim() || "codex") as RendererAgent;
    const resolved = getThreadAgent?.(hostId, threadId, rowAgent) ?? null;
    map.set(key, {
      hostId,
      threadId,
      title: (row.getAttribute(NATIVE_TITLE_ATTRIBUTE) ?? "").trim() || threadId,
      status: sidebarRowStatus(row),
      active: row.getAttribute(NATIVE_SELECTED_ATTRIBUTE) === "true",
      agent: resolved?.agent ?? rowAgent,
      ...(resolved?.plugin ? { plugin: resolved.plugin } : {}),
      rowElement: row,
    });
  }
  return map;
}

/** Codex keeps several pages mounted; the strip belongs to the one on screen. */
function findMountTarget(doc: Document): HTMLElement | null {
  return (
    doc.querySelector<HTMLElement>(
      `[${ACTIVE_PAGE_ATTRIBUTE}="true"] main[data-app-shell-main-surface]`,
    ) ?? doc.querySelector<HTMLElement>("main[data-app-shell-main-surface]")
  );
}

function iconSignature(agent: RendererAgent, plugin?: HarnessPluginDescriptor): string {
  const vector = plugin?.iconStyle?.vector;
  return `${agent}:${plugin?.icon ?? ""}:${vector ? `${vector.color}:${vector.paths.length}` : ""}`;
}

interface StripItem {
  readonly key: string;
  readonly snapshot: SidebarThreadSnapshot;
  readonly status: TopTabStatus;
  readonly active: boolean;
  readonly hostLabel: string | null;
  /** `undefined` for local threads; `null` for a remote host whose color is not known. */
  readonly hostColor: string | null | undefined;
}

/** Fills `columns × rows` cells; when more remain, the last cell becomes "+N" and the open thread stays visible. */
export function layoutTopTabs<T extends { readonly active: boolean }>(
  items: readonly T[],
  rows: number,
): { visible: T[]; overflow: T[] } {
  const capacity = TOP_TABS_COLUMNS * rows;
  if (items.length <= capacity) return { visible: [...items], overflow: [] };
  const visible = items.slice(0, capacity - 1);
  const overflow = items.slice(capacity - 1);
  const activeIndex = overflow.findIndex((item) => item.active);
  if (activeIndex >= 0) {
    const [active] = overflow.splice(activeIndex, 1);
    const displaced = visible.pop();
    if (displaced) overflow.unshift(displaced);
    if (active) visible.push(active);
  }
  return { visible, overflow };
}

export function installRendererTopTabs(
  options: InstallRendererTopTabsOptions = {},
): RendererTopTabsHandle {
  const doc = options.document ?? document;
  const win = options.window ?? doc.defaultView ?? window;
  const acknowledgedFailedKeys = options.acknowledgedFailedKeys ?? new Set<string>();

  let disposed = false;
  /** The thread being read keeps its tab until the user leaves it, even after it turns idle. */
  let viewedKey: string | null = null;
  let lastSignature = "";
  let menuOpen = false;
  /** `null` until the first collection, so stale Pet data from a previous run is replaced. */
  let lastSyncSignature: string | null = null;

  const rootKeyOf = (snapshot: SidebarThreadSnapshot): string =>
    `${snapshot.hostId}:${options.tree?.rootThread?.(snapshot.hostId, snapshot.threadId) ?? snapshot.threadId}`;

  const collectItems = (): StripItem[] => {
    const snapshots = collectSidebarThreads(doc, options.getThreadAgent);
    const groups = new Map<
      string,
      { root: SidebarThreadSnapshot; status: TopTabStatus; active: boolean }
    >();
    for (const [key, snapshot] of snapshots) {
      const rootKey = rootKeyOf(snapshot);
      const group = groups.get(rootKey);
      const root = snapshots.get(rootKey) ?? group?.root ?? snapshot;
      groups.set(rootKey, {
        root: key === rootKey ? snapshot : root,
        status: rollupTopTabStatus([snapshot.status, group?.status ?? "idle"]),
        active: snapshot.active || (group?.active ?? false),
      });
    }

    let acknowledgementsChanged = false;
    let activeKey: string | null = null;
    for (const [key, group] of groups) {
      if (group.active) activeKey = key;
      if (
        (group.status === "running" || group.status === "waiting") &&
        acknowledgedFailedKeys.delete(key)
      )
        acknowledgementsChanged = true;
    }
    const activeGroup = activeKey ? groups.get(activeKey) : undefined;
    if (
      activeKey &&
      activeGroup &&
      (viewedKey === activeKey ||
        isUnreadOrActiveSessionStatus(activeGroup.status, activeKey, acknowledgedFailedKeys))
    ) {
      viewedKey = activeKey;
      if (activeGroup.status === "failed" && !acknowledgedFailedKeys.has(activeKey)) {
        acknowledgedFailedKeys.add(activeKey);
        acknowledgementsChanged = true;
      }
    } else {
      viewedKey = null;
    }

    const syncSignature = [...snapshots]
      .map(([key, s]) => `${key}:${s.status}:${iconSignature(s.agent, s.plugin)}:${s.title}`)
      .join("|");
    if (acknowledgementsChanged || syncSignature !== lastSyncSignature) {
      lastSyncSignature = syncSignature;
      options.onChange?.();
    }

    const items: StripItem[] = [];
    const globeColors = readRemoteHostGlobeColors(doc);
    for (const [key, group] of groups) {
      const visible =
        viewedKey === key ||
        isUnreadOrActiveSessionStatus(group.status, key, acknowledgedFailedKeys);
      if (!visible) continue;
      items.push({
        key,
        snapshot: group.root,
        status: group.status,
        active: key === activeKey,
        hostLabel: resolveShortHostLabel(
          group.root.hostId,
          options.getHostLabel?.(group.root.hostId) ?? null,
        ),
        hostColor:
          group.root.hostId === "local" ? undefined : (globeColors.get(group.root.hostId) ?? null),
      });
    }
    return items;
  };

  const createTab = (item: StripItem, inMenu = false): HTMLButtonElement => {
    const { snapshot } = item;
    const tab = doc.createElement("button");
    tab.type = "button";
    tab.className = "codexhost-session-tab";
    tab.setAttribute("role", inMenu ? "menuitem" : "tab");
    tab.setAttribute(TOP_TAB_ATTRIBUTE, item.key);
    tab.setAttribute("data-status", item.status);
    tab.setAttribute("aria-selected", item.active ? "true" : "false");
    tab.title = item.hostLabel ? `${snapshot.title} · ${item.hostLabel}` : snapshot.title;

    const icon = doc.createElement("span");
    icon.className = "codexhost-session-tab-icon";
    icon.appendChild(createRendererAgentIcon(snapshot.agent, 14, doc, snapshot.plugin));
    tab.appendChild(icon);

    const title = doc.createElement("span");
    title.className = "codexhost-session-tab-title";
    title.textContent = snapshot.title;
    tab.appendChild(title);

    if (item.hostColor !== undefined)
      tab.appendChild(createRemoteHostGlobe(doc, item.hostColor, "codexhost-session-tab-host"));

    const glyph = snapshot.rowElement.querySelector(NATIVE_INDICATOR_GLYPH_SELECTOR);
    if (glyph) {
      const indicator = glyph.cloneNode(true) as HTMLElement;
      indicator.classList.add("codexhost-session-tab-indicator");
      tab.appendChild(indicator);
    }

    tab.addEventListener("click", (event) => {
      event.preventDefault();
      if (menuOpen) setMenuOpen(false);
      snapshot.rowElement.click();
    });
    return tab;
  };

  const setMenuOpen = (open: boolean): void => {
    if (menuOpen === open) return;
    menuOpen = open;
    lastSignature = "";
    render();
  };

  const createMore = (overflow: readonly StripItem[], locale: string): HTMLElement[] => {
    const more = doc.createElement("button");
    more.type = "button";
    more.className = "codexhost-session-tab";
    more.setAttribute(TOP_TABS_MORE_ATTRIBUTE, "true");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", menuOpen ? "true" : "false");
    more.setAttribute("data-status", rollupTopTabStatus(overflow.map((item) => item.status)));
    more.title = locale.startsWith("zh")
      ? `另外 ${overflow.length} 个会话`
      : `${overflow.length} more sessions`;
    more.textContent = `+${overflow.length}`;
    more.addEventListener("click", (event) => {
      event.preventDefault();
      setMenuOpen(!menuOpen);
    });
    if (!menuOpen) return [more];
    const menu = doc.createElement("div");
    menu.setAttribute(TOP_TABS_MENU_ATTRIBUTE, "true");
    menu.setAttribute("role", "menu");
    menu.append(...overflow.map((item) => createTab(item, true)));
    return [more, menu];
  };
  const render = (): void => {
    if (disposed) return;
    const surface = findMountTarget(doc);
    if (!surface) return;
    ensureTopTabsStyles(doc);

    let root = surface.querySelector<HTMLElement>(`:scope > [${TOP_TABS_ROOT_ATTRIBUTE}]`);
    for (const stale of doc.querySelectorAll(`[${TOP_TABS_ROOT_ATTRIBUTE}]`)) {
      if (stale !== root) stale.remove();
    }
    if (!root) {
      root = doc.createElement("div");
      root.setAttribute(TOP_TABS_ROOT_ATTRIBUTE, "true");
      root.setAttribute("role", "tablist");
      lastSignature = "";
    }
    if (surface.firstElementChild !== root) surface.prepend(root);

    const items = readTopTabsEnabledPreference(win) ? collectItems() : [];
    const rows = readTopTabsTwoRowsPreference(win) ? 2 : 1;
    const { visible, overflow } = layoutTopTabs(items, rows);
    if (overflow.length === 0) menuOpen = false;
    const locale = options.getLocale?.() ?? "en-US";
    const signature = JSON.stringify([
      locale,
      rows,
      menuOpen,
      overflow.length,
      items.map(({ key, snapshot, status, active, hostColor }) => [
        key,
        snapshot.title,
        status,
        active,
        hostColor,
        iconSignature(snapshot.agent, snapshot.plugin),
        snapshot.rowElement.getAttribute(NATIVE_INDICATOR_ATTRIBUTE),
      ]),
    ]);
    if (signature === lastSignature) return;
    lastSignature = signature;

    root.setAttribute("aria-label", locale.startsWith("zh") ? "活动会话" : "Active sessions");
    root.hidden = items.length === 0;
    root.replaceChildren(
      ...visible.map((item) => createTab(item)),
      ...(overflow.length > 0 ? createMore(overflow, locale) : []),
    );
  };

  // A timer rather than requestAnimationFrame: frames stall while the window is hidden or
  // occluded, but the strip must keep the Pet's session list current in that state.
  let pendingTimer: number | null = null;
  const scheduleRender = (): void => {
    if (disposed || pendingTimer !== null) return;
    pendingTimer = win.setTimeout(() => {
      pendingTimer = null;
      render();
    }, 50);
  };

  /** Sidebar rows changed, or the mount point itself was (re)placed; transcript updates are ignored. */
  const isRelevantMutation = (record: MutationRecord): boolean => {
    if (record.type === "attributes") return true;
    const target = record.target;
    if (!(target instanceof Element) || target.closest(`[${TOP_TABS_ROOT_ATTRIBUTE}]`))
      return false;
    if (target.closest(SIDEBAR_SCROLL_SELECTOR)) return true;
    const surface = findMountTarget(doc);
    return !surface || target === surface || target.contains(surface);
  };
  const observer = new MutationObserver((records) => {
    if (records.some(isRelevantMutation)) scheduleRender();
  });
  observer.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      ACTIVE_PAGE_ATTRIBUTE,
      NATIVE_INDICATOR_ATTRIBUTE,
      NATIVE_SELECTED_ATTRIBUTE,
      NATIVE_TITLE_ATTRIBUTE,
    ],
  });
  const unsubscribePreference = subscribeTopTabsPreference(win, scheduleRender);
  const onPointerDown = (event: Event): void => {
    const target = event.target;
    if (
      menuOpen &&
      !(
        target instanceof Element &&
        target.closest(`[${TOP_TABS_MENU_ATTRIBUTE}], [${TOP_TABS_MORE_ATTRIBUTE}]`)
      )
    )
      setMenuOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (menuOpen && event.key === "Escape") setMenuOpen(false);
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);

  render();

  return {
    refresh: () => {
      lastSignature = "";
      lastSyncSignature = null;
      render();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (pendingTimer !== null) win.clearTimeout(pendingTimer);
      observer.disconnect();
      unsubscribePreference();
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      for (const el of doc.querySelectorAll(`[${TOP_TABS_ROOT_ATTRIBUTE}]`)) el.remove();
    },
  };
}
