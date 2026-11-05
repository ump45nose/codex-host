/**
 * Sidebar DOM adapter for CodexHost.
 * Reuses native data-app-action-sidebar-* attributes and ignores thread-tree
 * mirror rows so nesting + stash do not fight over the same nodes.
 *
 * Mount placement mirrors ump45nose/codex-stash: pin the section inside the
 * sidebar scroll list as a sibling after Recents (or the last native section).
 * Falling back to the outer `aside`/`nav` shell is wrong — that prepends into
 * the left panel flex row and overlays the header / icon rail.
 */

import { canonicalThreadId } from "./thread-id.js";

export const SELECTORS = {
  threadButton: "[data-app-action-sidebar-thread-id]",
  threadCurrent: '[data-app-action-sidebar-thread-id][aria-current="page"]',
  threadTitle: "[data-app-action-sidebar-thread-title]",
  threadRow: "[data-app-action-sidebar-thread-row]",
  /** Native section nodes (Pinned / Projects / Recents / custom hosts). */
  section: "[data-app-action-sidebar-section]",
  /** Scrollable thread list. Prefer this over the outer aside shell. */
  scroll: "[data-app-action-sidebar-scroll]",
  /**
   * Sidebar shell candidates, most specific first. Never use a bare `nav` —
   * the icon rail is also a nav and would steal the first match.
   */
  sidebar: [
    "aside.app-shell-left-panel",
    'aside[data-testid="app-shell-floating-left-panel"]',
    '[data-pip-obstacle="app-shell-floating-left-panel"] aside',
    "aside",
  ],
  sectionKeyAttrs: [
    "data-app-action-sidebar-section",
    "data-app-action-sidebar-section-heading",
  ] as const,
} as const;

const MIRROR_ATTR = "data-codexhost-sidebar-thread-mirror";
const OWN_ATTR_PREFIX = "data-codexhost-sidebar-stash";
const OWN_ROOT_ATTR = "data-codexhost-sidebar-stash-root";

export interface MountPlacement {
  parent: HTMLElement;
  /** Prefer pinning right after this native section on every refresh. */
  after?: HTMLElement | null;
  before?: ChildNode | null;
  /** Native section row-gap, applied as margin-top when `after` is set. */
  gap?: string | null;
}

export interface SidebarAdapter {
  findMountPlacement(): MountPlacement | null;
  /** @deprecated Prefer findMountPlacement(); kept for older call sites/tests. */
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

/** Normalize a native section key: pinned / projects / recent / … or ''. */
export function nativeSectionKey(section: Element): string {
  for (const attr of SELECTORS.sectionKeyAttrs) {
    const raw = section.getAttribute(attr);
    if (!raw) continue;
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    if (key === "recents") return "recent";
    return key;
  }
  return "";
}

export function createSidebarAdapter(doc: Document = document): SidebarAdapter {
  function isOwnNode(node: Element | null | undefined): boolean {
    if (!node) return false;
    if (node.hasAttribute(OWN_ROOT_ATTR) || node.closest(`[${OWN_ROOT_ATTR}]`)) return true;
    for (const attr of node.getAttributeNames()) {
      if (attr.startsWith(OWN_ATTR_PREFIX)) return true;
    }
    return false;
  }

  function isMirrorOrOwn(node: Element): boolean {
    if (node.hasAttribute(MIRROR_ATTR)) return true;
    if (node.closest(`[${MIRROR_ATTR}]`)) return true;
    return isOwnNode(node);
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

  function findSidebarShell(): HTMLElement | null {
    for (const selector of SELECTORS.sidebar) {
      const found = doc.querySelector<HTMLElement>(selector);
      if (found && !isOwnNode(found)) return found;
    }
    const scroll = doc.querySelector<HTMLElement>(SELECTORS.scroll);
    return (scroll?.closest("aside") as HTMLElement | null) ?? null;
  }

  function nativeSections(scope: ParentNode): HTMLElement[] {
    return [...scope.querySelectorAll<HTMLElement>(SELECTORS.section)].filter(
      (section) => !isOwnNode(section),
    );
  }

  function nextHostNode(node: ChildNode | null | undefined): ChildNode | null {
    let current: ChildNode | null | undefined = node;
    while (current) {
      if (current.nodeType === 1 && isOwnNode(current as Element)) {
        current = current.nextSibling;
        continue;
      }
      if (current.nodeType === 1) return current;
      current = current.nextSibling;
    }
    return null;
  }

  function sectionGap(anchor: HTMLElement): string | null {
    const win = doc.defaultView;
    for (let node: HTMLElement | null = anchor.parentElement; node; node = node.parentElement) {
      const style = win?.getComputedStyle?.(node);
      if (!style) return null;
      if (style.display === "contents") continue;
      if (style.display.includes("flex") || style.display.includes("grid")) {
        return /^\d/u.test(style.rowGap) ? style.rowGap : null;
      }
      if (node !== anchor.parentElement) return null;
    }
    return null;
  }

  function findMountPlacement(): MountPlacement | null {
    const scroll = doc.querySelector<HTMLElement>(SELECTORS.scroll);
    const scope: ParentNode = scroll ?? findSidebarShell() ?? doc;
    if (!scroll && scope === doc) {
      // No sidebar shell / scroll yet — wait for the next observe tick.
      return null;
    }
    const sections = nativeSections(scope);
    const anchor =
      sections.find((section) => nativeSectionKey(section) === "recent") ??
      sections[sections.length - 1] ??
      null;
    if (anchor?.parentElement) {
      return {
        parent: anchor.parentElement,
        after: anchor,
        before: nextHostNode(anchor.nextSibling),
        gap: sectionGap(anchor),
      };
    }
    if (sections[0]?.parentElement) {
      return {
        parent: sections[0].parentElement,
        before: sections[0],
        after: null,
        gap: null,
      };
    }
    if (scroll) {
      // Empty scroll list: append inside the scroll container itself.
      return { parent: scroll, after: null, before: null, gap: null };
    }
    return null;
  }

  function findMountPoint(): HTMLElement | null {
    return findMountPlacement()?.parent ?? null;
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
    const pinnedSection = nativeSections(doc).find(
      (section) => nativeSectionKey(section) === "pinned",
    );
    if (!pinnedSection || !pinnedSection.contains(button)) return null;
    const pinnedButtons = [
      ...pinnedSection.querySelectorAll<HTMLElement>(SELECTORS.threadButton),
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
        "data-app-action-sidebar-section",
        "data-app-action-sidebar-section-heading",
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
    findMountPlacement,
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
