/**
 * Sidebar DOM adapter for CodexHost.
 * Reuses native data-app-action-sidebar-* attributes and ignores thread-tree
 * mirror rows so nesting + stash do not fight over the same nodes.
 */

import { canonicalThreadId } from "./thread-id.js";

export const SELECTORS = {
  threadButton: "[data-app-action-sidebar-thread-id]",
  threadCurrent: '[data-app-action-sidebar-thread-id][aria-current="page"]',
  threadTitle: "[data-app-action-sidebar-thread-title]",
  threadRow: "[data-app-action-sidebar-thread-row]",
  pinnedSection: "[data-app-action-sidebar-pinned-threads], [data-app-action-sidebar-pinned]",
  recentsSection: "[data-app-action-sidebar-recents], [data-app-action-sidebar-threads]",
  sidebar: "nav, [data-app-action-sidebar], aside",
} as const;

const MIRROR_ATTR = "data-codexhost-sidebar-thread-mirror";
const OWN_ATTR_PREFIX = "data-codexhost-sidebar-stash";

export interface SidebarAdapter {
  findMountPoint(): HTMLElement | null;
  listThreadButtons(): HTMLElement[];
  findThreadButton(threadId: string): HTMLElement | null;
  readThreadId(node: Element | null): string | null;
  readTitle(node: Element | null): string;
  readActiveThreadId(): string | null;
  openThread(threadId: string): boolean;
  readPinState(
    threadId: string,
  ): { wasPinned: true; index: number | null; beforeThreadId: string | null } | null;
  restorePin(
    threadId: string,
    pin: { index: number | null; beforeThreadId: string | null },
  ): boolean;
  observe(onChange: () => void): () => void;
}

export function createSidebarAdapter(doc: Document = document): SidebarAdapter {
  function isMirrorOrOwn(node: Element): boolean {
    if (node.hasAttribute(MIRROR_ATTR)) return true;
    if (node.closest(`[${MIRROR_ATTR}]`)) return true;
    for (const attr of node.getAttributeNames()) {
      if (attr.startsWith(OWN_ATTR_PREFIX)) return true;
    }
    if (node.closest(`[${OWN_ATTR_PREFIX}-root]`)) return true;
    return false;
  }

  function listThreadButtons(): HTMLElement[] {
    return [...doc.querySelectorAll<HTMLElement>(SELECTORS.threadButton)].filter(
      (node) => !isMirrorOrOwn(node),
    );
  }

  function readThreadId(node: Element | null): string | null {
    if (!node) return null;
    const raw =
      node.getAttribute("data-app-action-sidebar-thread-id") ||
      node.closest(SELECTORS.threadButton)?.getAttribute("data-app-action-sidebar-thread-id");
    if (!raw) return null;
    try {
      return canonicalThreadId(raw);
    } catch {
      return null;
    }
  }

  function readTitle(node: Element | null): string {
    if (!node) return "Untitled";
    const titled =
      node.querySelector?.(SELECTORS.threadTitle) ||
      node.closest(SELECTORS.threadRow)?.querySelector(SELECTORS.threadTitle) ||
      node;
    const text = (titled?.textContent || "").trim();
    return text || "Untitled";
  }

  function findThreadButton(threadId: string): HTMLElement | null {
    const want = (() => {
      try {
        return canonicalThreadId(threadId);
      } catch {
        return null;
      }
    })();
    if (!want) return null;
    for (const button of listThreadButtons()) {
      if (readThreadId(button) === want) return button;
    }
    return null;
  }

  function findMountPoint(): HTMLElement | null {
    const existing = doc.querySelector<HTMLElement>("[data-codexhost-sidebar-stash-root]");
    if (existing?.parentElement) return existing.parentElement;
    const pinned =
      doc.querySelector<HTMLElement>(SELECTORS.pinnedSection) ||
      doc.querySelector<HTMLElement>("[data-app-action-sidebar-pinned-threads]");
    if (pinned?.parentElement) return pinned.parentElement;
    const recents = doc.querySelector<HTMLElement>(SELECTORS.recentsSection);
    if (recents?.parentElement) return recents.parentElement;
    return doc.querySelector<HTMLElement>(SELECTORS.sidebar);
  }

  function readActiveThreadId(): string | null {
    const current = doc.querySelector(SELECTORS.threadCurrent);
    return readThreadId(current);
  }

  function openThread(threadId: string): boolean {
    const button = findThreadButton(threadId);
    if (!button) return false;
    button.click();
    return true;
  }

  function readPinState(threadId: string): {
    wasPinned: true;
    index: number | null;
    beforeThreadId: string | null;
  } | null {
    const button = findThreadButton(threadId);
    if (!button) return null;
    const pinnedRoot = doc.querySelector(SELECTORS.pinnedSection);
    if (!pinnedRoot || !pinnedRoot.contains(button)) return null;
    const pinnedButtons = [
      ...pinnedRoot.querySelectorAll<HTMLElement>(SELECTORS.threadButton),
    ].filter((node) => !isMirrorOrOwn(node));
    const index = pinnedButtons.indexOf(button);
    const before = index >= 0 ? pinnedButtons[index + 1] : null;
    return {
      wasPinned: true,
      index: index >= 0 ? index : null,
      beforeThreadId: before ? readThreadId(before) : null,
    };
  }

  function restorePin(
    threadId: string,
    pin: { index: number | null; beforeThreadId: string | null },
  ): boolean {
    void pin;
    const button = findThreadButton(threadId);
    if (!button) return false;
    const pinControl =
      button.querySelector<HTMLElement>(
        '[data-app-action-sidebar-thread-pin], [aria-label*="Pin" i], [aria-label*="置顶"]',
      ) ||
      button.parentElement?.querySelector<HTMLElement>(
        '[data-app-action-sidebar-thread-pin], [aria-label*="Pin" i], [aria-label*="置顶"]',
      );
    if (!pinControl) return false;
    pinControl.click();
    return true;
  }

  function observe(onChange: () => void): () => void {
    if (!doc.documentElement || typeof MutationObserver === "undefined") {
      return () => {};
    }
    let scheduled = false;
    let muteUntil = 0;
    const schedule = (): void => {
      if (scheduled) return;
      if (Date.now() < muteUntil) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (Date.now() < muteUntil) return;
        onChange();
      });
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target = mutation.target;
        if (target instanceof Element) {
          if (isMirrorOrOwn(target)) continue;
          if (
            mutation.type === "attributes" &&
            typeof mutation.attributeName === "string" &&
            mutation.attributeName.startsWith(OWN_ATTR_PREFIX)
          ) {
            continue;
          }
        }
        schedule();
        return;
      }
    });
    observer.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "data-app-action-sidebar-thread-id",
        "aria-current",
        "data-codexhost-sidebar-thread-mirror",
        "style",
        "hidden",
      ],
    });
    return () => {
      muteUntil = Date.now() + 50;
      observer.disconnect();
    };
  }

  return {
    findMountPoint,
    listThreadButtons,
    findThreadButton,
    readThreadId,
    readTitle,
    readActiveThreadId,
    openThread,
    readPinState,
    restorePin,
    observe,
  };
}
