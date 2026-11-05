/**
 * CodexHost renderer sidebar stash (收纳箱).
 *
 * Port of ump45nose/codex-stash (MIT). See NOTICE attribution in this directory.
 * Skips install when the standalone userscript guard `window.__codexStash_v1` is
 * present so both cannot double-render.
 */

import { createSidebarAdapter, type SidebarAdapter } from "./adapter.js";
import { browserNotificationPort, createReminderController } from "./reminders.js";
import { CHORDS, isEditableTarget, matchChord } from "./hotkey.js";
import { openDuePopover } from "./popover.js";
import { readSidebarStashEnabledPreference } from "./preference.js";
import { registerReservedHotkeys, STASH_RESERVED_HOTKEYS } from "./reserved-hotkeys.js";
import { createStashSection } from "./section.js";
import { createPersistedStore } from "./storage.js";
import { StashStore } from "./store.js";
import { pickStrings } from "./strings.js";
import { ensureStyles } from "./style.js";
import { ThreadIdError } from "./thread-id.js";

export const STANDALONE_GUARD = "__codexStash_v1";
export const HOST_GUARD = "__codexhostSidebarStashV1";
export const USER_MESSAGE_EVENT = "codexhost:user-message";

export interface InstallRendererSidebarStashOptions {
  document?: Document;
  window?: Window & typeof globalThis;
  storage?: Storage | null;
  externalFileRaw?: unknown;
  getLocale?: () => string | null | undefined;
  getEnabled?: () => boolean;
  adapter?: SidebarAdapter;
  Notification?: typeof Notification;
  logger?: Pick<Console, "info" | "warn" | "debug">;
}

export interface RendererSidebarStashHandle {
  dispose(): void;
  store: StashStore;
  refresh(): void;
}

type GuardedWindow = Window &
  typeof globalThis & {
    [STANDALONE_GUARD]?: unknown;
    [HOST_GUARD]?: { dispose?: () => void } | true;
  };

export function installRendererSidebarStash(
  options: InstallRendererSidebarStashOptions = {},
): RendererSidebarStashHandle | null {
  const win = (options.window ?? (typeof window !== "undefined" ? window : undefined)) as
    GuardedWindow | undefined;
  const doc = options.document ?? (typeof document !== "undefined" ? document : undefined);
  const log = options.logger ?? console;

  if (!win || !doc) return null;
  const ownerDocument = doc;
  const ownerWindow = win;

  if (ownerWindow[STANDALONE_GUARD]) {
    log.info?.(
      "[codexhost-sidebar-stash] standalone codex-stash detected (__codexStash_v1); skipping host install",
    );
    return null;
  }

  const existing = ownerWindow[HOST_GUARD];
  if (existing && typeof existing === "object" && typeof existing.dispose === "function") {
    existing.dispose();
  }

  if (!(options.getEnabled ?? (() => readSidebarStashEnabledPreference(options.storage)))()) {
    log.debug?.("[codexhost-sidebar-stash] disabled by preference");
    return null;
  }

  const locale = options.getLocale?.() ?? detectLocale(ownerDocument);
  const strings = pickStrings(locale);
  const adapter = options.adapter ?? createSidebarAdapter(ownerDocument);
  const { store, migratedFromLegacy, mergedExternalFile } = createPersistedStore(StashStore, {
    storage: options.storage === undefined ? safeLocalStorage() : options.storage,
    externalFileRaw: options.externalFileRaw,
  });
  if (migratedFromLegacy) {
    log.info?.("[codexhost-sidebar-stash] migrated state from localStorage codex-stash:v1");
  }
  if (mergedExternalFile) {
    log.info?.("[codexhost-sidebar-stash] merged newer ~/.codex-stash/stash.json payload");
  }

  const disposeStyle = ensureStyles(ownerDocument);
  const disposeHotkeys = registerReservedHotkeys(STASH_RESERVED_HOTKEYS);

  let menuEl: HTMLElement | null = null;
  let popoverClose: (() => void) | null = null;

  const section = createStashSection({
    document: ownerDocument,
    strings,
    locale: locale ?? "zh-CN",
    onOpen: (threadId) => {
      void restoreThread(threadId);
    },
    onContextMenu: (threadId, event, anchor) => {
      openRowMenu(threadId, event, anchor);
    },
  });

  const NotificationImpl = options.Notification;
  const reminder = createReminderController(
    NotificationImpl
      ? {
          get permission() {
            return NotificationImpl.permission;
          },
          requestPermission: () => NotificationImpl.requestPermission(),
          notify: (title, opts) => new NotificationImpl(title, opts),
        }
      : browserNotificationPort(),
    {
      strings: {
        overdueTitle: (count) =>
          count === 1 ? strings.notifyTitleOne : strings.notifyTitleMany(count),
      },
    },
  );

  function mountSection(): void {
    const mount = adapter.findMountPoint();
    if (!mount) return;
    if (section.root.parentElement !== mount) {
      const pinned =
        mount.querySelector(
          "[data-app-action-sidebar-pinned-threads], [data-app-action-sidebar-pinned]",
        ) || mount.querySelector("[data-codexhost-sidebar-stash-root]");
      if (pinned && pinned !== section.root) {
        mount.insertBefore(section.root, pinned.nextSibling);
      } else if (!section.root.isConnected) {
        mount.prepend(section.root);
      }
    }
  }

  function refresh(): void {
    mountSection();
    section.render(store.getState());
    reminder.sync(store.getState());
  }

  async function restoreThread(threadId: string): Promise<void> {
    const item = store.get(threadId);
    const opened = adapter.openThread(threadId);
    if (!opened) {
      log.warn?.("[codexhost-sidebar-stash] thread row not found for", threadId);
    }
    store.remove(threadId);
    if (item?.pin) {
      // Give the sidebar a tick to render the thread before re-pinning.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      adapter.restorePin(threadId, item.pin);
    }
    refresh();
  }

  function stashActive(dueAt?: string | null): void {
    const threadId = adapter.readActiveThreadId();
    if (!threadId) {
      log.debug?.("[codexhost-sidebar-stash] no active thread to stash");
      return;
    }
    const button = adapter.findThreadButton(threadId);
    const title = adapter.readTitle(button);
    const pin = adapter.readPinState(threadId) ?? undefined;
    try {
      store.put({
        threadId,
        title,
        dueAt: dueAt === undefined ? undefined : dueAt,
        pin,
      });
    } catch (error) {
      if (error instanceof ThreadIdError) {
        log.warn?.("[codexhost-sidebar-stash]", error.message);
        return;
      }
      throw error;
    }
    refresh();
  }

  function toggleActive(): void {
    const threadId = adapter.readActiveThreadId();
    if (!threadId) return;
    if (store.has(threadId)) {
      void restoreThread(threadId);
      return;
    }
    stashActive();
  }

  function jumpOverdue(): void {
    const state = store.getState();
    const now = Date.now();
    for (const [threadId, item] of Object.entries(state.items)) {
      if (item.dueAt && Date.parse(item.dueAt) <= now) {
        void restoreThread(threadId);
        return;
      }
    }
  }

  function openDueForActive(anchor?: HTMLElement): void {
    const threadId = adapter.readActiveThreadId();
    if (!threadId) return;
    if (!store.has(threadId)) stashActive(null);
    const item = store.get(threadId);
    popoverClose?.();
    const handle = openDuePopover({
      document: ownerDocument,
      strings,
      currentDueAt: item?.dueAt ?? null,
      anchor: anchor ?? fakeAnchor(),
      onSelect: (dueAt) => {
        store.put({ threadId, dueAt });
        refresh();
      },
      onClose: () => {
        popoverClose = null;
      },
    });
    popoverClose = () => handle.close();
  }

  function openRowMenu(threadId: string, event: MouseEvent, anchor: HTMLElement): void {
    closeMenu();
    const menu = ownerDocument.createElement("div");
    menu.setAttribute("data-codexhost-sidebar-stash-menu", "1");
    menu.setAttribute("role", "menu");
    const unstash = ownerDocument.createElement("button");
    unstash.type = "button";
    unstash.textContent = strings.menuUnstash;
    unstash.addEventListener("click", () => {
      closeMenu();
      void restoreThread(threadId);
    });
    const setDue = ownerDocument.createElement("button");
    setDue.type = "button";
    setDue.textContent = strings.menuSetDue;
    setDue.addEventListener("click", () => {
      closeMenu();
      const item = store.get(threadId);
      popoverClose?.();
      const handle = openDuePopover({
        document: ownerDocument,
        strings,
        currentDueAt: item?.dueAt ?? null,
        anchor,
        onSelect: (dueAt) => {
          store.put({ threadId, dueAt });
          refresh();
        },
        onClose: () => {
          popoverClose = null;
        },
      });
      popoverClose = () => handle.close();
    });
    menu.append(unstash, setDue);
    ownerDocument.body.appendChild(menu);
    const left = Math.min(Math.max(8, event.clientX), window.innerWidth - 200);
    const top = Math.min(Math.max(8, event.clientY), window.innerHeight - 100);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menuEl = menu;
    const onPointer = (ev: MouseEvent): void => {
      if (ev.target instanceof Node && menu.contains(ev.target)) return;
      closeMenu();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") closeMenu();
    };
    ownerDocument.addEventListener("mousedown", onPointer, true);
    ownerDocument.addEventListener("keydown", onKey, true);
    (menu as HTMLElement & { __cleanup?: () => void }).__cleanup = () => {
      ownerDocument.removeEventListener("mousedown", onPointer, true);
      ownerDocument.removeEventListener("keydown", onKey, true);
    };
  }

  function closeMenu(): void {
    if (!menuEl) return;
    const cleanup = (menuEl as HTMLElement & { __cleanup?: () => void }).__cleanup;
    cleanup?.();
    menuEl.remove();
    menuEl = null;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (isEditableTarget(event.target)) return;
    if (matchChord(event, CHORDS.stash)) {
      event.preventDefault();
      event.stopPropagation();
      toggleActive();
      return;
    }
    if (matchChord(event, CHORDS.due)) {
      event.preventDefault();
      event.stopPropagation();
      openDueForActive();
      return;
    }
    if (matchChord(event, CHORDS.jump)) {
      event.preventDefault();
      event.stopPropagation();
      jumpOverdue();
    }
  }

  function onUserMessage(event: Event): void {
    const detail = (event as CustomEvent<{ threadId?: string }>).detail;
    const threadId = detail?.threadId || adapter.readActiveThreadId();
    if (!threadId) return;
    if (!store.has(threadId)) return;
    void restoreThread(threadId);
  }

  function onContextMenu(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-codexhost-sidebar-stash-root]")) return;
    const button = target.closest<HTMLElement>("[data-app-action-sidebar-thread-id]");
    if (!button || button.hasAttribute("data-codexhost-sidebar-thread-mirror")) return;
    const threadId = adapter.readThreadId(button);
    if (!threadId) return;
    // Augment native menu lightly: Shift+contextmenu stashes.
    if (!event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (store.has(threadId)) {
      void restoreThread(threadId);
      return;
    }
    const title = adapter.readTitle(button);
    const pin = adapter.readPinState(threadId) ?? undefined;
    store.put({ threadId, title, pin });
    refresh();
  }

  const unsubscribe = store.subscribe(() => {
    section.render(store.getState());
    reminder.sync(store.getState());
  });
  const stopObserve = adapter.observe(() => {
    refresh();
  });

  ownerDocument.addEventListener("keydown", onKeyDown, true);
  ownerDocument.addEventListener("contextmenu", onContextMenu, true);
  ownerWindow.addEventListener(USER_MESSAGE_EVENT, onUserMessage as EventListener);

  refresh();

  let disposed = false;
  const handle: RendererSidebarStashHandle = {
    store,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      closeMenu();
      popoverClose?.();
      unsubscribe();
      stopObserve();
      reminder.dispose();
      disposeStyle();
      disposeHotkeys();
      section.dispose();
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      ownerDocument.removeEventListener("contextmenu", onContextMenu, true);
      ownerWindow.removeEventListener(USER_MESSAGE_EVENT, onUserMessage as EventListener);
      if (ownerWindow[HOST_GUARD] === handle) {
        Reflect.deleteProperty(ownerWindow, HOST_GUARD);
      }
    },
  };

  ownerWindow[HOST_GUARD] = handle;
  return handle;
}

function detectLocale(doc: Document): string {
  return doc.documentElement.lang || (typeof navigator !== "undefined" ? navigator.language : "en");
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function fakeAnchor(): { getBoundingClientRect(): DOMRect } {
  return {
    getBoundingClientRect: () =>
      ({
        x: 24,
        y: 80,
        top: 80,
        left: 24,
        bottom: 80,
        right: 24,
        width: 0,
        height: 0,
        toJSON() {
          return this;
        },
      }) as DOMRect,
  };
}

/** Emit from CodexHost send path so Harness sessions auto-unstash too. */
export function emitCodexHostUserMessage(
  threadId: string | null | undefined,
  target: Window | Document | EventTarget = typeof window !== "undefined"
    ? window
    : (undefined as never),
): void {
  if (!threadId || !target) return;
  try {
    target.dispatchEvent(
      new CustomEvent(USER_MESSAGE_EVENT, {
        detail: { threadId },
      }),
    );
  } catch {
    /* ignore */
  }
}
