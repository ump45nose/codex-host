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
import type { RendererSettingsLocale } from "../settings/localization.js";
import {
  readTopTabsEnabledPreference,
  readTopTabsMaxVisible,
  readTopTabsPersistedState,
  subscribeTopTabsPreference,
  writeTopTabsPersistedState,
  type TopTabPersistedItem,
} from "./preference.js";
import { ensureTopTabsStyles } from "./style.js";

export const TOP_TABS_ROOT_ATTRIBUTE = "data-codexhost-top-tabs";
export const TOP_TAB_ATTRIBUTE = "data-codexhost-top-tab";
export const TOP_TABS_MORE_ATTRIBUTE = "data-codexhost-top-tabs-more";
export const TOP_TABS_MENU_ATTRIBUTE = "data-codexhost-top-tabs-menu";

export type TopTabStatus = "waiting" | "failed" | "running" | "unread" | "idle";

const STATUS_PRIORITY: Readonly<Record<TopTabStatus, number>> = {
  waiting: 5,
  failed: 4,
  running: 3,
  unread: 2,
  idle: 1,
};

export interface SidebarThreadSnapshot {
  readonly hostId: string;
  readonly threadId: HostThreadId;
  readonly title: string;
  readonly status: TopTabStatus;
  readonly pinned: boolean;
  readonly active: boolean;
  readonly agent: RendererAgent;
  readonly plugin?: HarnessPluginDescriptor;
  readonly rowElement: HTMLElement;
}

export interface InstallRendererTopTabsOptions {
  readonly document?: Document;
  readonly window?: Window;
  readonly tree?: RendererSidebarThreadTree | null;
  readonly getLocale?: () => RendererSettingsLocale;
  readonly getActiveThread?: () => { hostId: string; threadId: string } | null;
  readonly getThreadAgent?: (
    hostId: string,
    threadId: string,
  ) => {
    agent: RendererAgent;
    plugin?: HarnessPluginDescriptor;
  } | null;
  readonly onSelectThread?: (hostId: string, threadId: string) => void;
}

export interface RendererTopTabsHandle {
  readonly refresh: () => void;
  readonly dispose: () => void;
}

export function rollupTopTabStatus(statuses: Iterable<TopTabStatus>): TopTabStatus {
  let best: TopTabStatus = "idle";
  for (const status of statuses) {
    if (STATUS_PRIORITY[status] > STATUS_PRIORITY[best]) {
      best = status;
    }
  }
  return best;
}

function inferSidebarRowStatus(row: HTMLElement): TopTabStatus {
  const statusAttr = (
    row.getAttribute("data-thread-status") ??
    row.getAttribute("data-status") ??
    ""
  ).toLowerCase();
  if (
    statusAttr.includes("wait") ||
    statusAttr.includes("approval") ||
    statusAttr.includes("question")
  ) {
    return "waiting";
  }
  if (statusAttr.includes("error") || statusAttr.includes("fail")) {
    return "failed";
  }
  if (
    statusAttr.includes("run") ||
    statusAttr.includes("stream") ||
    statusAttr.includes("progress")
  ) {
    return "running";
  }
  if (statusAttr.includes("unread") || statusAttr.includes("review")) {
    return "unread";
  }

  // Check native indicators inside the row (spinner, badge, unread dot)
  if (
    row.querySelector(
      '[data-thread-approval-badge], [data-testid*="approval"], [data-testid*="waiting"]',
    )
  ) {
    return "waiting";
  }
  if (row.querySelector('[data-testid*="error"], [data-thread-error]')) {
    return "failed";
  }
  if (
    row.querySelector(
      '[data-testid*="running"], [data-testid*="spinner"], svg.animate-spin, [aria-busy="true"]',
    )
  ) {
    return "running";
  }
  if (row.querySelector('[data-thread-unread], [data-unread="true"]')) {
    return "unread";
  }
  return "idle";
}

function isRowInPinnedSection(row: HTMLElement): boolean {
  const section = row.closest<HTMLElement>("[data-app-action-sidebar-section]");
  if (!section) return false;
  const attr = (section.getAttribute("data-app-action-sidebar-section") ?? "").toLowerCase();
  return attr.includes("pin");
}

function isRowSelected(row: HTMLElement): boolean {
  if (
    row.getAttribute("aria-current") === "page" ||
    row.getAttribute("aria-selected") === "true" ||
    row.getAttribute("data-active") === "true" ||
    row.getAttribute("data-state") === "active"
  ) {
    return true;
  }
  const trigger = row.querySelector<HTMLElement>("[data-thread-title-trigger]");
  return (
    trigger?.getAttribute("aria-current") === "page" ||
    trigger?.getAttribute("data-active") === "true"
  );
}

function readRowAgentFromIcon(row: HTMLElement): RendererAgent {
  const icon = row.querySelector<HTMLElement>(`[${SIDEBAR_AGENT_ICON_ATTRIBUTE}]`);
  const raw = icon?.getAttribute(SIDEBAR_AGENT_ICON_ATTRIBUTE);
  return (raw as RendererAgent) || "codex";
}

function resolveThreadIdFromRow(row: HTMLElement): HostThreadId | null {
  const fromFiber = threadIdFromSidebarRowElement(row);
  if (fromFiber) {
    const parsed = hostThreadIdSchema.safeParse(fromFiber);
    if (parsed.success) return parsed.data;
  }
  const attrs = sidebarThreadAttributes(row);
  if (!attrs) return null;
  const prefix = `${attrs.hostId}:`;
  const rawId = attrs.taskKey.startsWith(prefix)
    ? attrs.taskKey.slice(prefix.length)
    : attrs.taskKey;
  if (rawId.startsWith("client-new-thread:")) return null;
  const parsed = hostThreadIdSchema.safeParse(rawId);
  return parsed.success ? parsed.data : null;
}

export function collectSidebarThreads(
  doc: Document,
  getThreadAgent?: InstallRendererTopTabsOptions["getThreadAgent"],
): Map<string, SidebarThreadSnapshot> {
  const map = new Map<string, SidebarThreadSnapshot>();
  const rows = doc.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR);
  for (const row of rows) {
    if (row.hasAttribute("data-codexhost-sidebar-thread-mirror")) continue;
    const attrs = sidebarThreadAttributes(row);
    if (!attrs) continue;
    const threadId = resolveThreadIdFromRow(row);
    if (!threadId) continue;
    const key = `${attrs.hostId}:${threadId}`;
    if (map.has(key)) continue;

    const titleNode =
      row.querySelector<HTMLElement>("[data-thread-title]") ??
      row.querySelector<HTMLElement>("[data-thread-title-trigger]");
    const title = titleNode?.textContent?.trim() || threadId;
    const customAgent = getThreadAgent?.(attrs.hostId, threadId);
    const agent = customAgent?.agent ?? readRowAgentFromIcon(row);

    map.set(key, {
      hostId: attrs.hostId,
      threadId,
      title,
      status: inferSidebarRowStatus(row),
      pinned: isRowInPinnedSection(row),
      active: isRowSelected(row),
      agent,
      ...(customAgent?.plugin ? { plugin: customAgent.plugin } : {}),
      rowElement: row,
    });
  }
  return map;
}

export function installRendererTopTabs(
  options: InstallRendererTopTabsOptions = {},
): RendererTopTabsHandle {
  const doc = options.document ?? document;
  const win = options.window ?? doc.defaultView ?? window;
  const getLocale = options.getLocale ?? ((): RendererSettingsLocale => "zh-CN");

  ensureTopTabsStyles(doc);

  let disposed = false;
  let workingSet: TopTabPersistedItem[] = [...readTopTabsPersistedState(win).items];
  const dismissedKeys = new Set<string>();
  let openMenuCleanup: (() => void) | null = null;
  let lastRenderSignature = "";

  const closeOpenMenu = (): void => {
    if (openMenuCleanup) {
      openMenuCleanup();
      openMenuCleanup = null;
    }
    for (const menu of doc.querySelectorAll(`[${TOP_TABS_MENU_ATTRIBUTE}]`)) {
      menu.remove();
    }
    for (const trigger of doc.querySelectorAll(`[${TOP_TABS_MORE_ATTRIBUTE}]`)) {
      trigger.setAttribute("aria-expanded", "false");
    }
  };

  const persistWorkingSet = (): void => {
    writeTopTabsPersistedState({ version: 1, items: workingSet }, win);
  };

  const resolveRootId = (hostId: string, threadId: HostThreadId): HostThreadId => {
    return options.tree?.rootThread?.(hostId, threadId) ?? threadId;
  };

  const activateThread = (
    hostId: string,
    threadId: string,
    snapshots: Map<string, SidebarThreadSnapshot>,
  ): void => {
    closeOpenMenu();
    if (options.onSelectThread) {
      options.onSelectThread(hostId, threadId);
      return;
    }
    const snap = snapshots.get(`${hostId}:${threadId}`);
    if (snap) {
      const trigger =
        snap.rowElement.querySelector<HTMLElement>("[data-thread-title-trigger]") ??
        snap.rowElement;
      trigger.click();
    }
  };

  const openDropdownMenu = (
    anchor: HTMLElement,
    renderItems: (menu: HTMLElement) => void,
  ): void => {
    closeOpenMenu();
    const menu = doc.createElement("div");
    menu.setAttribute(TOP_TABS_MENU_ATTRIBUTE, "true");
    menu.setAttribute("role", "menu");
    renderItems(menu);
    doc.body.appendChild(menu);

    const rect = anchor.getBoundingClientRect();
    const top = Math.max(8, Math.round(rect.bottom + 6));
    const left = Math.max(8, Math.min(Math.round(rect.left), (win.innerWidth || 1024) - 260));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    anchor.setAttribute("aria-expanded", "true");

    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (
        target &&
        typeof menu.contains === "function" &&
        (menu.contains(target) || anchor.contains(target))
      ) {
        return;
      }
      closeOpenMenu();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeOpenMenu();
      }
    };
    doc.addEventListener("mousedown", onPointerDown, true);
    doc.addEventListener("keydown", onKeyDown, true);
    openMenuCleanup = () => {
      doc.removeEventListener("mousedown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
    };
  };

  const reconcileWorkingSet = (
    snapshots: Map<string, SidebarThreadSnapshot>,
    activeRootKey: string | null,
  ): TopTabPersistedItem[] => {
    const existingByKey = new Map<string, TopTabPersistedItem>();
    const next: TopTabPersistedItem[] = [];

    // 1. Keep existing workingSet items in their stable order if still present in sidebar (and root)
    for (const item of workingSet) {
      const parsedId = hostThreadIdSchema.safeParse(item.threadId);
      if (!parsedId.success) continue;
      const rootId = resolveRootId(item.hostId, parsedId.data);
      const rootKey = `${item.hostId}:${rootId}`;
      if (existingByKey.has(rootKey)) continue;
      const snap = snapshots.get(rootKey);
      if (!snap) continue;
      const updated: TopTabPersistedItem = {
        hostId: item.hostId,
        threadId: rootId,
        pinned: item.pinned || snap.pinned,
        title: snap.title,
      };
      existingByKey.set(rootKey, updated);
      next.push(updated);
    }

    // 2. Ensure pinned root threads in sidebar are in the working set
    for (const [key, snap] of snapshots) {
      if (!snap.pinned || dismissedKeys.has(key)) continue;
      const rootId = resolveRootId(snap.hostId, snap.threadId);
      const rootKey = `${snap.hostId}:${rootId}`;
      if (existingByKey.has(rootKey)) continue;
      const rootSnap = snapshots.get(rootKey) ?? snap;
      const item: TopTabPersistedItem = {
        hostId: rootSnap.hostId,
        threadId: rootSnap.threadId,
        pinned: true,
        title: rootSnap.title,
      };
      existingByKey.set(rootKey, item);
      next.push(item);
    }

    // 3. Ensure the currently active thread's root is in the working set
    if (activeRootKey && !existingByKey.has(activeRootKey)) {
      const activeSnap = snapshots.get(activeRootKey);
      if (activeSnap) {
        dismissedKeys.delete(activeRootKey);
        const item: TopTabPersistedItem = {
          hostId: activeSnap.hostId,
          threadId: activeSnap.threadId,
          pinned: activeSnap.pinned,
          title: activeSnap.title,
        };
        existingByKey.set(activeRootKey, item);
        next.push(item);
      }
    }

    // 4. Seed up to maxVisible from top unarchived root threads if working set is empty
    const maxVisible = readTopTabsMaxVisible(win);
    if (next.length < Math.min(3, maxVisible)) {
      for (const [, snap] of snapshots) {
        if (next.length >= maxVisible) break;
        const rootId = resolveRootId(snap.hostId, snap.threadId);
        const rootKey = `${snap.hostId}:${rootId}`;
        if (existingByKey.has(rootKey) || dismissedKeys.has(rootKey)) continue;
        const rootSnap = snapshots.get(rootKey) ?? snap;
        const item: TopTabPersistedItem = {
          hostId: rootSnap.hostId,
          threadId: rootSnap.threadId,
          pinned: rootSnap.pinned,
          title: rootSnap.title,
        };
        existingByKey.set(rootKey, item);
        next.push(item);
      }
    }

    workingSet = next;
    persistWorkingSet();
    return next;
  };

  const render = (): void => {
    if (disposed) return;
    const enabled = readTopTabsEnabledPreference(win);
    const toolbar =
      doc.querySelector<HTMLElement>("[data-app-shell-header-toolbar]") ??
      doc.querySelector<HTMLElement>(".Toolbar-w4tLPD");

    if (!enabled || !toolbar) {
      closeOpenMenu();
      for (const existing of doc.querySelectorAll(`[${TOP_TABS_ROOT_ATTRIBUTE}]`)) {
        existing.remove();
      }
      lastRenderSignature = "";
      return;
    }

    const snapshots = collectSidebarThreads(doc, options.getThreadAgent);
    let activeThread = options.getActiveThread?.() ?? null;
    if (!activeThread) {
      for (const snap of snapshots.values()) {
        if (snap.active) {
          activeThread = { hostId: snap.hostId, threadId: snap.threadId };
          break;
        }
      }
    }

    let activeRootKey: string | null = null;
    const activeExactKey = activeThread ? `${activeThread.hostId}:${activeThread.threadId}` : null;
    if (activeThread) {
      const parsed = hostThreadIdSchema.safeParse(activeThread.threadId);
      const rootId = parsed.success
        ? resolveRootId(activeThread.hostId, parsed.data)
        : activeThread.threadId;
      activeRootKey = `${activeThread.hostId}:${rootId}`;
    }

    const items = reconcileWorkingSet(snapshots, activeRootKey);
    const maxVisible = readTopTabsMaxVisible(win);

    // Ensure active root tab is within visible slots without reshuffling the existing visible tabs
    const visibleItems: TopTabPersistedItem[] = items.slice(0, maxVisible);
    const overflowItems: TopTabPersistedItem[] = items.slice(maxVisible);
    if (
      activeRootKey &&
      !visibleItems.some((item) => `${item.hostId}:${item.threadId}` === activeRootKey)
    ) {
      const activeIdx = overflowItems.findIndex(
        (item) => `${item.hostId}:${item.threadId}` === activeRootKey,
      );
      if (activeIdx !== -1 && visibleItems.length > 0) {
        const [promoted] = overflowItems.splice(activeIdx, 1);
        const displaced = visibleItems.pop();
        if (promoted) visibleItems.push(promoted);
        if (displaced) overflowItems.unshift(displaced);
      }
    }

    // Also include any other root threads from sidebar that aren't in visibleItems in the overflow list
    const visibleKeySet = new Set(visibleItems.map((i) => `${i.hostId}:${i.threadId}`));
    const overflowKeySet = new Set(overflowItems.map((i) => `${i.hostId}:${i.threadId}`));
    for (const snap of snapshots.values()) {
      const rootId = resolveRootId(snap.hostId, snap.threadId);
      const rootKey = `${snap.hostId}:${rootId}`;
      if (visibleKeySet.has(rootKey) || overflowKeySet.has(rootKey)) continue;
      const rootSnap = snapshots.get(rootKey) ?? snap;
      overflowKeySet.add(rootKey);
      overflowItems.push({
        hostId: rootSnap.hostId,
        threadId: rootSnap.threadId,
        pinned: rootSnap.pinned,
        title: rootSnap.title,
      });
    }

    const locale = getLocale();
    const signature = JSON.stringify({
      locale,
      activeExactKey,
      activeRootKey,
      visible: visibleItems.map((item) => {
        const key = `${item.hostId}:${item.threadId}`;
        const snap = snapshots.get(key);
        const parsed = hostThreadIdSchema.safeParse(item.threadId);
        const children = parsed.success
          ? (options.tree?.liveDescendants(item.hostId, parsed.data) ?? [])
          : [];
        const statuses: TopTabStatus[] = [
          snap?.status ?? "idle",
          ...children.map((cid) => snapshots.get(`${item.hostId}:${cid}`)?.status ?? "idle"),
        ];
        return {
          key,
          title: snap?.title ?? item.title ?? item.threadId,
          agent: snap?.agent ?? "codex",
          status: rollupTopTabStatus(statuses),
          childCount: children.length,
        };
      }),
      overflowCount: overflowItems.length,
    });

    let root = toolbar.querySelector<HTMLElement>(`[${TOP_TABS_ROOT_ATTRIBUTE}]`);
    if (root && signature === lastRenderSignature) {
      return;
    }
    lastRenderSignature = signature;

    if (!root) {
      root = doc.createElement("div");
      root.setAttribute(TOP_TABS_ROOT_ATTRIBUTE, "true");
      root.setAttribute("data-tab-id", "codexhost-top-tabs");
      root.setAttribute("role", "tablist");
      const rightActions = toolbar.querySelector<HTMLElement>(".ms-auto");
      if (rightActions && rightActions.parentElement === toolbar) {
        toolbar.insertBefore(root, rightActions);
      } else {
        toolbar.appendChild(root);
      }
    }

    root.replaceChildren();
    if (visibleItems.length === 0 && overflowItems.length === 0) {
      return;
    }

    const listEl = doc.createElement("div");
    listEl.setAttribute("data-codexhost-top-tabs-list", "true");
    root.appendChild(listEl);

    for (const item of visibleItems) {
      const key = `${item.hostId}:${item.threadId}`;
      const snap = snapshots.get(key);
      const parsedId = hostThreadIdSchema.safeParse(item.threadId);
      const childIds = parsedId.success
        ? (options.tree?.liveDescendants(item.hostId, parsedId.data) ?? [])
        : [];
      const childSnapshots = childIds
        .map((cid) => snapshots.get(`${item.hostId}:${cid}`))
        .filter((s): s is SidebarThreadSnapshot => s !== undefined);

      const rolledStatus = rollupTopTabStatus([
        snap?.status ?? "idle",
        ...childSnapshots.map((c) => c.status),
      ]);
      const isActiveRoot = activeRootKey === key;
      const activeChildSnap = childSnapshots.find(
        (c) => `${c.hostId}:${c.threadId}` === activeExactKey,
      );

      const tab = doc.createElement("div");
      tab.setAttribute(TOP_TAB_ATTRIBUTE, key);
      tab.setAttribute("data-host-id", item.hostId);
      tab.setAttribute("data-thread-id", item.threadId);
      tab.setAttribute("role", "tab");
      tab.tabIndex = 0;
      tab.setAttribute("aria-selected", isActiveRoot ? "true" : "false");
      tab.setAttribute("data-active", isActiveRoot ? "true" : "false");

      const displaySnap = activeChildSnap ?? snap;
      const displayTitle = displaySnap?.title ?? item.title ?? item.threadId;
      tab.title = item.hostId !== "local" ? `[${item.hostId}] ${displayTitle}` : displayTitle;

      // Agent Icon
      const iconWrap = doc.createElement("span");
      iconWrap.setAttribute("data-codexhost-top-tab-icon", "true");
      iconWrap.appendChild(
        createRendererAgentIcon(displaySnap?.agent ?? "codex", 13, doc, displaySnap?.plugin),
      );
      tab.appendChild(iconWrap);

      // Title (with optional remote host badge)
      const titleSpan = doc.createElement("span");
      titleSpan.setAttribute("data-codexhost-top-tab-title", "true");
      if (item.hostId !== "local") {
        const hostBadge = doc.createElement("span");
        hostBadge.setAttribute("data-codexhost-top-tab-host", "true");
        hostBadge.textContent = `[${item.hostId}]`;
        titleSpan.appendChild(hostBadge);
      }
      titleSpan.append(displayTitle);
      tab.appendChild(titleSpan);

      // Status dot
      const statusDot = doc.createElement("span");
      statusDot.setAttribute("data-codexhost-top-tab-status", "true");
      statusDot.setAttribute("data-status", rolledStatus);
      tab.appendChild(statusDot);

      // Child threads count badge & dropdown trigger
      if (childSnapshots.length > 0) {
        const childBtn = doc.createElement("button");
        childBtn.type = "button";
        childBtn.setAttribute("data-codexhost-top-tab-children", "true");
        childBtn.textContent = `${childSnapshots.length} ▾`;
        childBtn.title =
          locale === "zh-CN"
            ? `${childSnapshots.length} 个子会话`
            : `${childSnapshots.length} child threads`;
        childBtn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openDropdownMenu(childBtn, (menu) => {
            const header = doc.createElement("div");
            header.setAttribute("data-codexhost-top-tabs-menu-section", "true");
            header.textContent = locale === "zh-CN" ? "父会话与子会话" : "Parent & Child Threads";
            menu.appendChild(header);

            const allGroup = [snap, ...childSnapshots].filter(
              (s): s is SidebarThreadSnapshot => s !== undefined,
            );
            for (const entry of allGroup) {
              const entryKey = `${entry.hostId}:${entry.threadId}`;
              const btn = doc.createElement("button");
              btn.type = "button";
              btn.setAttribute("data-codexhost-top-tabs-menu-item", entryKey);
              btn.setAttribute("data-active", entryKey === activeExactKey ? "true" : "false");
              const icon = doc.createElement("span");
              icon.setAttribute("data-codexhost-top-tab-icon", "true");
              icon.appendChild(createRendererAgentIcon(entry.agent, 13, doc, entry.plugin));
              const label = doc.createElement("span");
              label.setAttribute("data-codexhost-top-tab-title", "true");
              label.textContent =
                entry.threadId === item.threadId ? entry.title : `↳ ${entry.title}`;
              const dot = doc.createElement("span");
              dot.setAttribute("data-codexhost-top-tab-status", "true");
              dot.setAttribute("data-status", entry.status);
              btn.append(icon, label, dot);
              btn.addEventListener("click", () => {
                activateThread(entry.hostId, entry.threadId, snapshots);
              });
              menu.appendChild(btn);
            }
          });
        });
        tab.appendChild(childBtn);
      }

      // Close button
      const closeBtn = doc.createElement("button");
      closeBtn.type = "button";
      closeBtn.setAttribute("data-codexhost-top-tab-close", "true");
      closeBtn.setAttribute(
        "aria-label",
        locale === "zh-CN" ? "从标签栏移除" : "Remove from tab bar",
      );
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        dismissedKeys.add(key);
        workingSet = workingSet.filter((w) => `${w.hostId}:${w.threadId}` !== key);
        persistWorkingSet();
        lastRenderSignature = "";
        render();
      });
      tab.appendChild(closeBtn);

      tab.addEventListener("click", () => {
        const targetId = activeChildSnap ? activeChildSnap.threadId : item.threadId;
        activateThread(item.hostId, targetId, snapshots);
      });
      tab.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activateThread(item.hostId, item.threadId, snapshots);
        }
      });

      listEl.appendChild(tab);
    }

    // Overflow "More · N" button
    if (overflowItems.length > 0) {
      const overflowBtn = doc.createElement("button");
      overflowBtn.type = "button";
      overflowBtn.setAttribute(TOP_TABS_MORE_ATTRIBUTE, "true");
      overflowBtn.setAttribute("aria-haspopup", "menu");
      overflowBtn.setAttribute("aria-expanded", "false");

      const overflowStatuses = overflowItems.map(
        (item) => snapshots.get(`${item.hostId}:${item.threadId}`)?.status ?? "idle",
      );
      const overflowRollup = rollupTopTabStatus(overflowStatuses);

      const labelSpan = doc.createElement("span");
      labelSpan.textContent =
        locale === "zh-CN" ? `更多 · ${overflowItems.length}` : `More · ${overflowItems.length}`;
      overflowBtn.appendChild(labelSpan);

      const dot = doc.createElement("span");
      dot.setAttribute("data-codexhost-top-tab-status", "true");
      dot.setAttribute("data-status", overflowRollup);
      overflowBtn.appendChild(dot);

      overflowBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openDropdownMenu(overflowBtn, (menu) => {
          const header = doc.createElement("div");
          header.setAttribute("data-codexhost-top-tabs-menu-section", "true");
          header.textContent = locale === "zh-CN" ? "更多工作会话" : "More Sessions";
          menu.appendChild(header);

          for (const item of overflowItems) {
            const key = `${item.hostId}:${item.threadId}`;
            const snap = snapshots.get(key);
            const btn = doc.createElement("button");
            btn.type = "button";
            btn.setAttribute("data-codexhost-top-tabs-menu-item", key);
            btn.setAttribute("data-active", key === activeRootKey ? "true" : "false");

            const icon = doc.createElement("span");
            icon.setAttribute("data-codexhost-top-tab-icon", "true");
            icon.appendChild(
              createRendererAgentIcon(snap?.agent ?? "codex", 13, doc, snap?.plugin),
            );

            const label = doc.createElement("span");
            label.setAttribute("data-codexhost-top-tab-title", "true");
            const rawTitle = snap?.title ?? item.title ?? item.threadId;
            label.textContent = item.hostId !== "local" ? `[${item.hostId}] ${rawTitle}` : rawTitle;

            const statusDot = doc.createElement("span");
            statusDot.setAttribute("data-codexhost-top-tab-status", "true");
            statusDot.setAttribute("data-status", snap?.status ?? "idle");

            btn.append(icon, label, statusDot);
            btn.addEventListener("click", () => {
              dismissedKeys.delete(key);
              if (!workingSet.some((w) => `${w.hostId}:${w.threadId}` === key)) {
                const nextPinned = snap?.pinned ?? item.pinned;
                const nextTitle = snap?.title ?? item.title;
                workingSet = [
                  {
                    hostId: item.hostId,
                    threadId: item.threadId,
                    ...(nextPinned !== undefined ? { pinned: nextPinned } : {}),
                    ...(nextTitle !== undefined ? { title: nextTitle } : {}),
                  },
                  ...workingSet,
                ];
                persistWorkingSet();
              }
              activateThread(item.hostId, item.threadId, snapshots);
              lastRenderSignature = "";
              render();
            });
            menu.appendChild(btn);
          }
        });
      });

      root.appendChild(overflowBtn);
    }
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

  const unsubscribePref = subscribeTopTabsPreference(win, () => {
    lastRenderSignature = "";
    scheduleRender();
  });

  const mutationObserver =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          scheduleRender();
        })
      : null;
  if (mutationObserver && doc.documentElement) {
    mutationObserver.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-current",
        "aria-selected",
        "data-active",
        "data-state",
        "data-thread-status",
        SIDEBAR_AGENT_ICON_ATTRIBUTE,
      ],
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
      closeOpenMenu();
      unsubscribePref();
      mutationObserver?.disconnect();
      for (const el of doc.querySelectorAll(`[${TOP_TABS_ROOT_ATTRIBUTE}]`)) {
        el.remove();
      }
    },
  };
}
