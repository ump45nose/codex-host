import { DEFAULT_RENDERER_AGENTS, type RendererAgent } from "./agent-selection-state.js";
import { createRendererAgentIcon, rendererAgentLabel } from "./renderer-agent-icon.js";
import {
  RENDERER_NEW_THREAD_PREFERENCE_KEY,
  readNewThreadAgentPreference,
  writeNewThreadAgentPreference,
} from "./renderer-new-thread-preference.js";

export const AVATAR_OVERLAY_STYLE_ID = "codexhost-avatar-overlay-styles";
export const AVATAR_OVERLAY_ROOT_ATTR = "data-codexhost-avatar-overlay";
export const AVATAR_OVERLAY_AGENT_PILL_ATTR = "data-codexhost-pets-agent-pill";
export const AVATAR_OVERLAY_AGENT_MENU_ATTR = "data-codexhost-pets-agent-menu";
export const AVATAR_OVERLAY_REMOTE_LIST_ATTR = "data-codexhost-pets-remote-list";
export const AVATAR_OVERLAY_REMOTE_ITEM_ATTR = "data-codexhost-pets-remote-item";
export const AVATAR_OVERLAY_PREVIEW_EXPAND_ATTR = "data-codexhost-pets-preview-expanded";

export const PETS_REMOTE_THREADS_STORAGE_KEY = "codexhost.pets-remote-threads.v1";
export const PETS_OPEN_THREAD_REQUEST_STORAGE_KEY = "codexhost.pets-open-thread-request.v1";
export const DEFAULT_PETS_STACK_MAX_HEIGHT_PX = 520;

export interface PetsRemoteThreadSummary {
  readonly hostId: string;
  readonly threadId: string;
  readonly title: string;
  readonly status: "waiting" | "failed" | "running" | "unread" | "idle";
  readonly agent?: RendererAgent;
  readonly preview?: string;
  readonly updatedAt?: number;
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
}

export interface RendererAvatarOverlayHandle {
  readonly refresh: () => void;
  readonly dispose: () => void;
}

export function isAvatarOverlayLocation(
  loc: Pick<Location, "href" | "pathname"> | null | undefined,
): boolean {
  if (!loc) return false;
  return loc.pathname.includes("avatar-overlay") || loc.href.includes("avatar-overlay.html");
}

export function computePetsStackMaxHeightPx(win?: Window | null): number {
  const availHeight = win?.screen?.availHeight ?? 0;
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
      if (typeof item !== "object" || item === null) continue;
      const hostId = (item as { hostId?: unknown }).hostId;
      const threadId = (item as { threadId?: unknown }).threadId;
      const title = (item as { title?: unknown }).title;
      const status = (item as { status?: unknown }).status;
      const agent = (item as { agent?: unknown }).agent;
      const preview = (item as { preview?: unknown }).preview;
      if (
        typeof hostId !== "string" ||
        hostId.length === 0 ||
        hostId === "local" ||
        typeof threadId !== "string" ||
        threadId.length === 0 ||
        typeof title !== "string"
      ) {
        continue;
      }
      result.push({
        hostId,
        threadId,
        title,
        status:
          status === "waiting" || status === "failed" || status === "running" || status === "unread"
            ? status
            : "idle",
        ...(typeof agent === "string" ? { agent: agent as RendererAgent } : {}),
        ...(typeof preview === "string" && preview.length > 0 ? { preview } : {}),
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
    storage.setItem(PETS_REMOTE_THREADS_STORAGE_KEY, JSON.stringify(threads));
  } catch {
    // Ignore storage quota errors
  }
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

export function buildAvatarOverlayCss(maxHeightPx: number): string {
  return `
/* CodexHost Pets (avatar-overlay.html) Vertical Screen & Remote Host Enhancements */
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] {
  --codexhost-pets-stack-max-height: ${maxHeightPx}px;
}

/* Expand activity stack scroll viewport from hardcoded 208px to 520px (capped at 60% screen height) */
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [style*="max-height: 208px"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [style*="max-height:208px"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] .max-h-\\[208px\\],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-codexhost-pets-activity-scroll="true"] {
  max-height: var(--codexhost-pets-stack-max-height, 520px) !important;
  overflow-y: auto !important;
  overscroll-behavior: contain;
}

/* Allow activity titles to show up to 2 lines and expand cleanly */
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-native-surface-id^="activity-"] {
  min-width: 228px;
  max-width: 340px;
}

html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [data-avatar-overlay-native-surface-id^="activity-"] .truncate {
  white-space: normal !important;
  display: -webkit-box !important;
  -webkit-line-clamp: 2 !important;
  -webkit-box-orient: vertical !important;
  overflow: hidden !important;
  line-height: 1.3 !important;
}

/* Full-text scrollable & resizable left preview bubble */
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [role="log"],
html[${AVATAR_OVERLAY_ROOT_ATTR}="true"] [${AVATAR_OVERLAY_PREVIEW_EXPAND_ATTR}="true"] {
  max-height: min(520px, 64vh) !important;
  min-width: 280px !important;
  max-width: 520px !important;
  overflow-y: auto !important;
  overscroll-behavior: contain !important;
  white-space: pre-wrap !important;
  word-break: break-word !important;
  resize: both;
}

/* Remote SSH sessions list inside Pets activity stack */
[${AVATAR_OVERLAY_REMOTE_LIST_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  pointer-events: auto;
}

[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 228px;
  max-width: 340px;
  padding: 7px 10px;
  border-radius: 12px;
  border: 1px solid rgba(127, 127, 127, 0.24);
  background-color: color-mix(in oklab, var(--color-surface, #1e1e1e) 94%, transparent);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28);
  color: var(--color-text-primary, #f3f4f6);
  font-size: 12px;
  line-height: 1.3;
  text-align: start;
  cursor: pointer;
  pointer-events: auto;
}

[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}]:hover {
  background-color: color-mix(in oklab, var(--color-surface, #262626) 98%, currentColor 6%);
}

[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] [data-remote-host-badge] {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  border-radius: 5px;
  background-color: rgba(59, 130, 246, 0.16);
  color: #60a5fa;
  font-size: 10.5px;
  font-weight: 600;
  flex-shrink: 0;
}

[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] [data-remote-title] {
  flex: 1 1 auto;
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
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
[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}] [data-remote-status="idle"] {
  background-color: rgba(156, 163, 175, 0.55);
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
  position: fixed;
  z-index: 100;
  min-width: 168px;
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 10px;
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
  border-radius: 6px;
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

export function installRendererAvatarOverlay(
  options: InstallRendererAvatarOverlayOptions = {},
): RendererAvatarOverlayHandle {
  const doc = options.document ?? document;
  const win = options.window ?? doc.defaultView ?? window;
  const enabledAgents = [...new Set(options.enabledAgents ?? DEFAULT_RENDERER_AGENTS)];
  const enabledAgentsSet = new Set<RendererAgent>(enabledAgents);

  const maxHeightPx = computePetsStackMaxHeightPx(win);
  doc.documentElement?.setAttribute(AVATAR_OVERLAY_ROOT_ATTR, "true");
  ensureAvatarOverlayStyles(doc, maxHeightPx);

  let disposed = false;
  let closeAgentMenu: (() => void) | null = null;
  const userScrolledUpContainers = new WeakSet<HTMLElement>();

  const readStorage = (): Storage | null => {
    try {
      return win.localStorage ?? null;
    } catch {
      return null;
    }
  };

  const reconcileActivityStackViewport = (): void => {
    // Find the parent container of native activity surfaces and mark it as expandable
    const firstActivity = doc.querySelector<HTMLElement>(
      '[data-avatar-overlay-native-surface-id^="activity-"]',
    );
    if (firstActivity) {
      let current: HTMLElement | null = firstActivity.parentElement;
      for (let depth = 0; current && depth < 5; depth += 1) {
        const inlineMax = current.style.maxHeight;
        const cls = current.className || "";
        if (inlineMax === "208px" || cls.includes("overflow-y-auto") || cls.includes("max-h-")) {
          current.setAttribute("data-codexhost-pets-activity-scroll", "true");
          if (inlineMax === "208px") {
            current.style.maxHeight = `${computePetsStackMaxHeightPx(win)}px`;
          }
          break;
        }
        current = current.parentElement;
      }
    }
  };

  const reconcilePreviewContainers = (): void => {
    const logs = doc.querySelectorAll<HTMLElement>(
      '[role="log"], [data-avatar-overlay-native-surface-id="transcript"], [data-avatar-overlay-native-surface-id^="preview"]',
    );
    for (const log of logs) {
      if (log.getAttribute(AVATAR_OVERLAY_PREVIEW_EXPAND_ATTR) !== "true") {
        log.setAttribute(AVATAR_OVERLAY_PREVIEW_EXPAND_ATTR, "true");
        log.addEventListener(
          "scroll",
          () => {
            const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
            if (atBottom) {
              userScrolledUpContainers.delete(log);
            } else {
              userScrolledUpContainers.add(log);
            }
          },
          { passive: true },
        );
      }
    }
  };

  const reconcileRemoteThreadsList = (): void => {
    const storage = readStorage();
    const remoteThreads = readPetsRemoteThreads(storage);
    const anchorParent =
      doc.querySelector<HTMLElement>('[data-codexhost-pets-activity-scroll="true"]') ??
      doc.querySelector<HTMLElement>('[data-avatar-overlay-native-surface-id^="activity-"]')
        ?.parentElement ??
      doc.body;

    if (!anchorParent) return;

    let listEl = doc.querySelector<HTMLElement>(`[${AVATAR_OVERLAY_REMOTE_LIST_ATTR}]`);
    if (remoteThreads.length === 0) {
      listEl?.remove();
      return;
    }

    if (!listEl) {
      listEl = doc.createElement("div");
      listEl.setAttribute(AVATAR_OVERLAY_REMOTE_LIST_ATTR, "true");
      anchorParent.appendChild(listEl);
    }

    const signature = JSON.stringify(remoteThreads);
    if (listEl.getAttribute("data-signature") === signature) {
      return;
    }
    listEl.setAttribute("data-signature", signature);
    listEl.replaceChildren();

    remoteThreads.forEach((thread, idx) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.setAttribute(AVATAR_OVERLAY_REMOTE_ITEM_ATTR, `${thread.hostId}:${thread.threadId}`);
      // Give it a native surface id so AvatarOverlayNativePage's rD() includes it in pointer hit regions!
      btn.setAttribute(
        "data-avatar-overlay-native-surface-id",
        `activity-remote-${thread.hostId}-${idx}`,
      );

      if (thread.agent) {
        const iconSpan = doc.createElement("span");
        iconSpan.appendChild(createRendererAgentIcon(thread.agent, 13, doc));
        btn.appendChild(iconSpan);
      }

      const hostBadge = doc.createElement("span");
      hostBadge.setAttribute("data-remote-host-badge", "true");
      hostBadge.textContent = `[${thread.hostId}]`;
      btn.appendChild(hostBadge);

      const titleSpan = doc.createElement("span");
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

  const renderComposerAgentPill = (): void => {
    const composer = doc.querySelector<HTMLElement>(
      '[data-avatar-overlay-native-surface-id="composer"]',
    );
    if (!composer) {
      closeAgentMenu?.();
      return;
    }

    const storage = readStorage();
    const currentAgent = readNewThreadAgentPreference(enabledAgentsSet, storage) ?? "codex";

    let pill = composer.querySelector<HTMLButtonElement>(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`);
    if (!pill) {
      const createdPill = doc.createElement("button");
      createdPill.type = "button";
      createdPill.setAttribute(AVATAR_OVERLAY_AGENT_PILL_ATTR, "true");
      createdPill.className = "codexhost-trigger-chip";
      createdPill.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (closeAgentMenu) {
          closeAgentMenu();
          return;
        }
        openAgentPickerMenu(createdPill);
      });
      const footerRow =
        composer.querySelector<HTMLElement>(".flex.items-center.justify-between") ??
        composer.querySelector<HTMLElement>("form") ??
        composer;
      footerRow.prepend(createdPill);
      pill = createdPill;
    }

    if (pill.getAttribute("data-agent") !== currentAgent) {
      pill.setAttribute("data-agent", currentAgent);
      pill.replaceChildren();
      pill.appendChild(createRendererAgentIcon(currentAgent, 13, doc));
      const label = doc.createElement("span");
      label.textContent = rendererAgentLabel(currentAgent);
      const caret = doc.createElement("span");
      caret.textContent = "▾";
      caret.style.opacity = "0.65";
      pill.append(label, caret);
    }
  };

  const openAgentPickerMenu = (anchor: HTMLElement): void => {
    closeAgentMenu?.();
    const storage = readStorage();
    const selectedAgent = readNewThreadAgentPreference(enabledAgentsSet, storage) ?? "codex";

    const menu = doc.createElement("div");
    menu.setAttribute(AVATAR_OVERLAY_AGENT_MENU_ATTR, "true");
    menu.setAttribute("data-avatar-overlay-native-surface-id", "composer-agent-menu");
    menu.setAttribute("role", "menu");

    for (const agent of enabledAgents) {
      const item = doc.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("data-agent-option", agent);
      item.setAttribute("data-selected", agent === selectedAgent ? "true" : "false");
      item.appendChild(createRendererAgentIcon(agent, 13, doc));
      const text = doc.createElement("span");
      text.textContent = rendererAgentLabel(agent);
      item.appendChild(text);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        writeNewThreadAgentPreference(agent, readStorage());
        closeAgentMenu?.();
        renderComposerAgentPill();
      });
      menu.appendChild(item);
    }

    doc.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.round(rect.left))}px`;
    menu.style.top = `${Math.max(8, Math.round(rect.top - menu.offsetHeight - 6))}px`;

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
      menu.remove();
      closeAgentMenu = null;
    };
  };

  const refresh = (): void => {
    if (disposed) return;
    reconcileActivityStackViewport();
    reconcilePreviewContainers();
    reconcileRemoteThreadsList();
    renderComposerAgentPill();
  };

  const onStorage = (event: StorageEvent): void => {
    if (
      !event.key ||
      event.key === PETS_REMOTE_THREADS_STORAGE_KEY ||
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

  return {
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      closeAgentMenu?.();
      observer?.disconnect();
      win.removeEventListener("storage", onStorage);
      doc.documentElement?.removeAttribute(AVATAR_OVERLAY_ROOT_ATTR);
      doc.getElementById(AVATAR_OVERLAY_STYLE_ID)?.remove();
      for (const el of doc.querySelectorAll(
        `[${AVATAR_OVERLAY_AGENT_PILL_ATTR}], [${AVATAR_OVERLAY_REMOTE_LIST_ATTR}]`,
      )) {
        el.remove();
      }
    },
  };
}
