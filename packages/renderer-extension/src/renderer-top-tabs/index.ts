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
import { readTopTabsEnabledPreference, subscribeTopTabsPreference } from "./preference.js";
import { ensureTopTabsStyles } from "./style.js";

export const TOP_TABS_ROOT_ATTRIBUTE = "data-codexhost-top-tabs";
export const TOP_TAB_ATTRIBUTE = "data-codexhost-top-tab";

export type TopTabStatus = "waiting" | "failed" | "running" | "unread" | "idle";
export type TopTabsDensityMode = "normal" | "crowded" | "compact-icons";

const STATUS_PRIORITY: Readonly<Record<TopTabStatus, number>> = {
  waiting: 5,
  failed: 4,
  running: 3,
  unread: 2,
  idle: 1,
};

const STATUS_LABELS: Readonly<Record<TopTabStatus, [string, string]>> = {
  running: ["运行中", "Running"],
  waiting: ["待审批", "Approval"],
  unread: ["未读", "Unread"],
  failed: ["失败", "Failed"],
  idle: ["就绪", "Idle"],
};

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

export interface ActiveSessionStripItem extends Omit<SidebarThreadSnapshot, "rowElement"> {
  readonly key: string;
  readonly hostLabel: string | null;
  readonly iconSignature: string;
}

export interface InstallRendererTopTabsOptions {
  readonly document?: Document;
  readonly window?: Window;
  readonly tree?: Pick<RendererSidebarThreadTree, "rootThread" | "liveDescendants"> | null;
  readonly getLocale?: () => string;
  readonly getActiveThread?: () => { hostId: string; threadId: HostThreadId } | null;
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
  const raw = (customLabel?.trim() || id).replace(/^ssh:\/\//i, "").replace(/^[^@]+@/, "");
  if (!id || id === "local" || !raw || raw === "local") return null;
  const ipv4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(raw);
  if (ipv4?.[1]) return ipv4[1];
  const base = (raw.replace(/:\d+$/, "").split(".")[0] ?? raw).trim() || id;
  return KNOWN_HOST_CASING[base.toLowerCase()] ?? base.slice(0, 16);
}

export function computeAgentIconSignature(
  agent: RendererAgent,
  plugin?: HarnessPluginDescriptor,
): string {
  const vec = plugin?.iconStyle?.vector;
  return `${agent}:${plugin?.name ?? ""}:${plugin?.icon ?? ""}:${vec ? `${vec.color}:${vec.paths.length}` : ""}`;
}

export function isUnreadOrActiveSessionStatus(
  status: TopTabStatus,
  key: string,
  acknowledgedFailedKeys: ReadonlySet<string>,
): boolean {
  if (status === "running" || status === "waiting" || status === "unread") return true;
  return status === "failed" && !acknowledgedFailedKeys.has(key);
}

export function computeTopTabsDensity(
  availableWidth: number,
  itemCount: number,
): TopTabsDensityMode {
  if (itemCount === 0) return "normal";
  const avgPerTab = (availableWidth > 0 ? availableWidth : 800) / itemCount;
  if (itemCount >= 6 || avgPerTab < 135) return "compact-icons";
  if (itemCount >= 4 || avgPerTab < 185) return "crowded";
  return "normal";
}

export function rollupTopTabStatus(statuses: Iterable<TopTabStatus>): TopTabStatus {
  let best: TopTabStatus = "idle";
  for (const status of statuses) {
    if (STATUS_PRIORITY[status] > STATUS_PRIORITY[best]) best = status;
  }
  return best;
}

const WAIT_SEL =
  '[data-thread-approval-badge], [data-testid*="approval"], [data-testid*="waiting"]';
const RUN_SEL =
  '[data-testid*="running"], [data-testid*="spinner"], svg.animate-spin, [aria-busy="true"]';
const TITLE_SEL = "[data-thread-title], [data-thread-title-trigger]";

function inferSidebarRowStatus(row: HTMLElement): TopTabStatus {
  const a =
    `${row.getAttribute("data-thread-status") ?? ""} ${row.getAttribute("data-status") ?? ""}`.toLowerCase();
  if (/wait|approval|question/.test(a) || row.querySelector(WAIT_SEL)) return "waiting";
  if (/error|fail/.test(a) || row.querySelector('[data-testid*="error"], [data-thread-error]'))
    return "failed";
  if (/run|stream|progress/.test(a) || row.querySelector(RUN_SEL)) return "running";
  if (/unread|review/.test(a) || row.querySelector('[data-thread-unread], [data-unread="true"]'))
    return "unread";
  return "idle";
}

function isRowSelected(row: HTMLElement): boolean {
  return (
    row.getAttribute("aria-current") === "page" ||
    row.getAttribute("aria-selected") === "true" ||
    row.getAttribute("data-active") === "true" ||
    row.getAttribute("data-selected") === "true" ||
    row.getAttribute("data-state") === "active" ||
    /\b(bg-token-list-active|is-active)\b/.test(row.className || "")
  );
}

function readRowTitle(row: HTMLElement, fallbackId: string): string {
  const raw =
    row.querySelector(TITLE_SEL)?.textContent ||
    row.getAttribute("data-thread-title") ||
    row.getAttribute("title") ||
    row.textContent ||
    "";
  return raw.replace(/\s+/g, " ").trim() || fallbackId;
}

function resolveThreadIdFromRow(row: HTMLElement): HostThreadId | null {
  const fiberId = threadIdFromSidebarRowElement(row);
  const attrs = sidebarThreadAttributes(row);
  const raw =
    fiberId ||
    (attrs?.taskKey.startsWith(`${attrs.hostId}:`)
      ? attrs.taskKey.slice(attrs.hostId.length + 1)
      : attrs?.taskKey);
  if (!raw || raw.startsWith("client-new-thread:")) return null;
  const parsed = hostThreadIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function collectSidebarThreads(
  doc: Document,
  getThreadAgent?: InstallRendererTopTabsOptions["getThreadAgent"],
): Map<string, SidebarThreadSnapshot> {
  const map = new Map<string, SidebarThreadSnapshot>();
  for (const row of doc.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)) {
    if (row.hasAttribute("data-codexhost-sidebar-thread-mirror")) continue;
    const attrs = sidebarThreadAttributes(row);
    const threadId = attrs ? resolveThreadIdFromRow(row) : null;
    if (!attrs || !threadId) continue;
    const key = `${attrs.hostId}:${threadId}`;
    const existing = map.get(key);
    const rowAgent = (row
      .querySelector<HTMLElement>(`[${SIDEBAR_AGENT_ICON_ATTRIBUTE}]`)
      ?.getAttribute(SIDEBAR_AGENT_ICON_ATTRIBUTE)
      ?.trim() ||
      row.getAttribute("data-agent")?.trim() ||
      "codex") as RendererAgent;
    const custom = getThreadAgent?.(attrs.hostId, threadId, rowAgent) ?? null;
    const plugin = custom?.plugin ?? existing?.plugin;
    map.set(key, {
      hostId: attrs.hostId,
      threadId,
      title: existing?.title ?? readRowTitle(row, threadId),
      status: rollupTopTabStatus([
        inferSidebarRowStatus(row),
        ...(existing ? [existing.status] : []),
      ]),
      active: isRowSelected(row) || (existing?.active ?? false),
      agent: custom?.agent ?? existing?.agent ?? rowAgent,
      ...(plugin ? { plugin } : {}),
      rowElement: existing?.rowElement ?? row,
    });
  }
  return map;
}

const SURFACE_SELECTORS = [
  '[data-app-shell-active-page="true"] [data-app-shell-main-surface]',
  '[data-app-shell-main-surface="default"], [data-app-shell-main-surface], [class*="MainContentSurface"]',
  '[data-app-shell-active-page="true"] [class*="PageSurface"], [data-app-shell-active-page="true"].page-surface',
  '[data-page-surface], [data-app-shell-page-surface], .page-surface, [class*="PageSurface"]',
  '[data-app-shell-active-page="true"], [role="main"], main',
];

function isValidPageSurfaceMountTarget(el: HTMLElement | null | undefined): el is HTMLElement {
  return Boolean(
    el &&
    el.getAttribute("data-app-shell-frame") !== "true" &&
    !el.hasAttribute("data-app-shell-frame") &&
    !el.closest("[data-app-shell-titlebar]") &&
    !el.querySelector("[data-app-shell-titlebar]"),
  );
}

function findPageSurfaceMountTarget(doc: Document): HTMLElement | null {
  for (const selector of SURFACE_SELECTORS) {
    for (const el of doc.querySelectorAll<HTMLElement>(selector)) {
      if (isValidPageSurfaceMountTarget(el)) return el;
    }
  }
  return null;
}

export function installRendererTopTabs(
  options: InstallRendererTopTabsOptions = {},
): RendererTopTabsHandle {
  const doc = options.document ?? (typeof document !== "undefined" ? document : null);
  const win = options.window ?? (typeof window !== "undefined" ? window : null);
  const acknowledgedFailedKeys = options.acknowledgedFailedKeys ?? new Set<string>();
  if (!doc || !win) {
    return { refresh: () => undefined, dispose: () => undefined };
  }

  let disposed = false;
  let viewedLeaseKey: string | null = null;
  let optimisticActiveKey: string | null = null;
  let lastDomActiveKey: string | null = null;
  let lastRenderSignature = "";
  let lastSnapshotsSignature = "";
  let currentTrack: HTMLElement | null = null;
  let currentGlider: HTMLElement | null = null;

  const createEl = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    attrs?: Record<string, string>,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  const resolveRootThreadId = (hostId: string, threadId: HostThreadId): HostThreadId =>
    options.tree?.rootThread ? options.tree.rootThread(hostId, threadId) : threadId;

  const computeSurfaceDensity = (
    s: HTMLElement | null | undefined,
    itemCount: number,
  ): TopTabsDensityMode => {
    const w =
      s?.clientWidth || s?.offsetWidth || win.innerWidth || doc.documentElement?.clientWidth || 800;
    return computeTopTabsDensity(Math.max(200, w - 48), itemCount);
  };

  const syncGlider = (): void => {
    if (!currentTrack || !currentGlider) return;
    const selected = currentTrack.querySelector<HTMLElement>('.session-slot[data-selected="true"]');
    currentGlider.style.opacity = selected ? "1" : "0";
    currentGlider.style.width = `${selected?.offsetWidth ?? 0}px`;
    if (selected)
      currentGlider.style.transform = `translate3d(${selected.offsetLeft ?? 0}px, 0, 0)`;
  };

  const syncDensityAndGlider = (itemCount: number): void => {
    if (!currentTrack) return;
    const surface = currentTrack.closest<HTMLElement>(
      `[${TOP_TABS_ROOT_ATTRIBUTE}]`,
    )?.parentElement;
    currentTrack.setAttribute("data-density", computeSurfaceDensity(surface, itemCount));
    syncGlider();
  };

  const ensureRootContainer = (surface: HTMLElement): HTMLElement => {
    for (const el of doc.querySelectorAll<HTMLElement>(`[${TOP_TABS_ROOT_ATTRIBUTE}]`)) {
      if (el.parentElement !== surface || !isValidPageSurfaceMountTarget(el.parentElement))
        el.remove();
    }
    let root = surface.querySelector<HTMLElement>(`[${TOP_TABS_ROOT_ATTRIBUTE}]`);
    if (!root) {
      root = createEl("div", "session-strip-shell", {
        [TOP_TABS_ROOT_ATTRIBUTE]: "true",
        role: "region",
      });
    }
    if (surface.firstChild !== root) surface.insertBefore(root, surface.firstChild);
    return root;
  };

  const render = (): void => {
    if (disposed) return;
    ensureTopTabsStyles(doc);
    const surface = findPageSurfaceMountTarget(doc);
    if (!surface) return;

    const locale = options.getLocale?.() ?? "en-US";
    const root = ensureRootContainer(surface);
    root.setAttribute("aria-label", locale.startsWith("zh") ? "活动会话" : "Active sessions");

    const collapseRoot = (sig: string): void => {
      root.setAttribute("data-hidden", "true");
      root.setAttribute("aria-hidden", "true");
      root.replaceChildren();
      currentTrack = currentGlider = null;
      lastRenderSignature = sig;
    };

    if (!readTopTabsEnabledPreference(win)) return collapseRoot("disabled");

    const snapshots = collectSidebarThreads(doc, options.getThreadAgent);
    const groupedByRoot = new Map<string, SidebarThreadSnapshot>();
    for (const snap of snapshots.values()) {
      const rootThreadId = resolveRootThreadId(snap.hostId, snap.threadId);
      const rootKey = `${snap.hostId}:${rootThreadId}`;
      const existing = groupedByRoot.get(rootKey);
      const base = existing ?? snapshots.get(rootKey) ?? snap;
      groupedByRoot.set(rootKey, {
        ...base,
        threadId: rootThreadId,
        status: existing ? rollupTopTabStatus([existing.status, snap.status]) : snap.status,
        active: (existing?.active ?? false) || snap.active,
      });
    }

    let ackChanged = false;
    for (const [key, entry] of groupedByRoot) {
      if (
        (entry.status === "running" || entry.status === "waiting") &&
        acknowledgedFailedKeys.delete(key)
      ) {
        ackChanged = true;
      }
    }

    let domActiveKey: string | null = null;
    const explicitActive = options.getActiveThread?.();
    if (explicitActive) {
      const parsed = hostThreadIdSchema.safeParse(explicitActive.threadId);
      if (parsed.success)
        domActiveKey = `${explicitActive.hostId}:${resolveRootThreadId(explicitActive.hostId, parsed.data)}`;
    }
    if (!domActiveKey) {
      for (const [key, entry] of groupedByRoot) {
        if (entry.active) {
          domActiveKey = key;
          break;
        }
      }
    }

    if (domActiveKey !== lastDomActiveKey) {
      optimisticActiveKey = null;
      lastDomActiveKey = domActiveKey;
    }
    const activeRootKey =
      optimisticActiveKey && groupedByRoot.has(optimisticActiveKey)
        ? optimisticActiveKey
        : domActiveKey;

    if (viewedLeaseKey && activeRootKey !== viewedLeaseKey) viewedLeaseKey = null;
    const activeEntry = activeRootKey ? groupedByRoot.get(activeRootKey) : undefined;
    if (
      activeRootKey &&
      activeEntry &&
      (isUnreadOrActiveSessionStatus(activeEntry.status, activeRootKey, acknowledgedFailedKeys) ||
        viewedLeaseKey === activeRootKey)
    ) {
      viewedLeaseKey = activeRootKey;
      if (activeEntry.status === "failed" && !acknowledgedFailedKeys.has(activeRootKey)) {
        acknowledgedFailedKeys.add(activeRootKey);
        ackChanged = true;
      }
    } else {
      viewedLeaseKey = null;
    }

    const nextSnapshotsSig = [...snapshots.entries()]
      .map(
        ([k, s]) =>
          `${k}:${s.status}:${s.agent}:${computeAgentIconSignature(s.agent, s.plugin)}:${s.title}`,
      )
      .join("|");
    if (ackChanged || nextSnapshotsSig !== lastSnapshotsSignature) {
      lastSnapshotsSignature = nextSnapshotsSig;
      options.onChange?.();
    }

    const visibleItems: ActiveSessionStripItem[] = [];
    for (const [key, entry] of groupedByRoot) {
      if (
        !isUnreadOrActiveSessionStatus(entry.status, key, acknowledgedFailedKeys) &&
        !(viewedLeaseKey === key && activeRootKey === key)
      )
        continue;
      const hostLabel = resolveShortHostLabel(
        entry.hostId,
        options.getHostLabel?.(entry.hostId) ?? null,
      );
      visibleItems.push({
        ...entry,
        key,
        hostLabel,
        iconSignature: computeAgentIconSignature(entry.agent, entry.plugin),
        active: key === activeRootKey,
      });
    }

    if (visibleItems.length === 0) return collapseRoot("empty");

    root.setAttribute("data-hidden", "false");
    root.removeAttribute("aria-hidden");

    const density = computeSurfaceDensity(surface, visibleItems.length);
    const signature = JSON.stringify([
      locale,
      density,
      visibleItems.map((i) => [i.key, i.hostLabel, i.title, i.status, i.iconSignature, i.active]),
    ]);

    if (signature === lastRenderSignature && currentTrack && root.contains(currentTrack)) {
      syncGlider();
      return;
    }
    lastRenderSignature = signature;

    root.replaceChildren();
    const bar = createEl("div", "session-strip-bar");
    const track = createEl("div", "session-pill-track", {
      "data-codexhost-top-tabs-list": "true",
      "data-density": density,
      role: "tablist",
    });
    const glider = createEl("div", "active-glider-pill", {
      "data-codexhost-top-tabs-glider": "true",
    });
    track.appendChild(glider);
    currentTrack = track;
    currentGlider = glider;

    for (const item of visibleItems) {
      const slot = createEl("div", "session-slot", {
        "data-session-slot": item.key,
        "data-selected": item.active ? "true" : "false",
        "data-icon-signature": item.iconSignature,
      });
      const btn = createEl("button", "session-pill-btn", {
        role: "tab",
        [TOP_TAB_ATTRIBUTE]: item.key,
        "data-host-id": item.hostId,
        "data-thread-id": item.threadId,
        "data-agent": item.agent,
        "data-status": item.status,
        "data-active": item.active ? "true" : "false",
        "aria-selected": item.active ? "true" : "false",
      });
      btn.type = "button";
      btn.title = item.hostLabel ? `[${item.hostLabel}] ${item.title}` : item.title;

      const iconWrap = createEl("span", "s-icon", { "data-codexhost-top-tab-icon": "true" });
      iconWrap.appendChild(createRendererAgentIcon(item.agent, 14, doc, item.plugin));
      btn.appendChild(iconWrap);
      if (item.hostId !== "local" && item.hostLabel) {
        btn.appendChild(
          createEl(
            "span",
            "s-host-badge",
            { "data-codexhost-top-tab-host": "true" },
            item.hostLabel,
          ),
        );
      }
      btn.appendChild(
        createEl(
          "span",
          "s-title session-title",
          { "data-codexhost-top-tab-title": "true" },
          item.title,
        ),
      );
      const stateText = STATUS_LABELS[item.status][locale.startsWith("zh") ? 0 : 1];
      btn.appendChild(createEl("span", "s-state-label", { "data-st": item.status }, stateText));
      btn.appendChild(
        createEl("span", "s-status", {
          "data-codexhost-top-tab-status": "true",
          "data-st": item.status,
          "data-status": item.status,
        }),
      );

      const resetFloating = (): void => {
        slot.removeAttribute("data-floating");
        slot.removeAttribute("data-align-right");
        slot.style.flex = slot.style.width = slot.style.minWidth = slot.style.maxWidth = "";
      };

      slot.addEventListener("pointerenter", () => {
        if (
          track.getAttribute("data-density") !== "compact-icons" ||
          slot.getAttribute("data-selected") === "true"
        )
          return;
        const startW = slot.offsetWidth || 42;
        slot.style.flex = `0 0 ${startW}px`;
        slot.style.width = slot.style.minWidth = slot.style.maxWidth = `${startW}px`;
        slot.setAttribute("data-floating", "true");
        const naturalW = Math.min(340, Math.max((btn.scrollWidth || 160) + 6, 150));
        const barW = bar.clientWidth || root.clientWidth || track.offsetWidth || 600;
        const slotLeft = slot.offsetLeft || 0;
        if (slotLeft + naturalW > barW - 8 && slotLeft + startW >= naturalW)
          slot.setAttribute("data-align-right", "true");
        else slot.removeAttribute("data-align-right");
      });

      slot.addEventListener("pointerleave", resetFloating);

      const onActivateSlot = (event: Event): void => {
        event.preventDefault();
        event.stopPropagation();
        resetFloating();
        viewedLeaseKey = optimisticActiveKey = item.key;
        if (item.status === "failed" && !acknowledgedFailedKeys.has(item.key)) {
          acknowledgedFailedKeys.add(item.key);
          options.onChange?.();
        }
        snapshots.get(item.key)?.rowElement.click();
        lastRenderSignature = "";
        render();
      };

      slot.addEventListener("click", onActivateSlot);
      slot.appendChild(btn);
      track.appendChild(slot);
    }

    bar.appendChild(track);
    root.appendChild(bar);
    syncDensityAndGlider(visibleItems.length);
  };

  let scanScheduled = false;
  const scheduleFrame =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
  const scheduleRender = (): void => {
    if (disposed || scanScheduled) return;
    scanScheduled = true;
    scheduleFrame(() => {
      scanScheduled = false;
      render();
    });
  };

  const onResize = (): void => {
    if (!disposed && currentTrack)
      syncDensityAndGlider(currentTrack.querySelectorAll(".session-slot").length);
  };
  win.addEventListener("resize", onResize);
  const unsubscribePref = subscribeTopTabsPreference(win, () => {
    lastRenderSignature = "";
    scheduleRender();
  });

  const isExtMut = (m: MutationRecord): boolean =>
    !(m.target as HTMLElement | null)?.closest?.(`[${TOP_TABS_ROOT_ATTRIBUTE}]`);
  const mutationObserver =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver((ms) => {
          if (ms.some(isExtMut)) scheduleRender();
        })
      : null;
  if (mutationObserver && doc.documentElement) {
    mutationObserver.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  }

  render();

  return {
    refresh: () => {
      lastRenderSignature = "";
      render();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      win.removeEventListener("resize", onResize);
      unsubscribePref();
      mutationObserver?.disconnect();
      for (const el of doc.querySelectorAll(`[${TOP_TABS_ROOT_ATTRIBUTE}]`)) el.remove();
    },
  };
}
