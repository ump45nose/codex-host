import type { HostThreadId } from "@codexhost/shared-contracts";

import type { TopTabStatus } from "./index.js";

export const TOP_TAB_STASH_ATTRIBUTE = "data-codexhost-top-tab-stash";
export const TOP_TAB_CONTEXT_MENU_ATTRIBUTE = "data-codexhost-top-tab-context-menu";

export interface TopTabsStashTarget {
  readonly hostId: string;
  readonly threadId: HostThreadId;
  readonly title: string;
}

/** The sidebar stash (收纳箱) as the strip sees it; the stash may be turned off or remounted. */
export interface TopTabsStash {
  available(): boolean;
  isStashed(threadId: HostThreadId): boolean;
  stash(target: TopTabsStashTarget): void;
  unstash(threadId: HostThreadId): void;
  setRestoreDate(target: TopTabsStashTarget, anchor: HTMLElement): void;
  subscribe(listener: () => void): () => void;
}

/** A reply, a request for input, or a failure brings a stashed session back. */
const NEWS: ReadonlySet<TopTabStatus> = new Set(["waiting", "unread", "failed"]);

/**
 * Hides stashed sessions from the strip. A stashed session whose status turns to news after
 * the strip has seen it leaves the stash, so it shows again and the stash box stays truthful.
 */
export function createStashedSessionFilter(
  stash: TopTabsStash | undefined,
): (key: string, threadId: HostThreadId, status: TopTabStatus) => boolean {
  const lastStatus = new Map<string, TopTabStatus>();
  return (key, threadId, status) => {
    const previous = lastStatus.get(key);
    lastStatus.set(key, status);
    if (!stash?.available() || !stash.isStashed(threadId)) return false;
    if (previous !== undefined && previous !== status && NEWS.has(status)) {
      stash.unstash(threadId);
      return false;
    }
    return true;
  };
}

function strings(locale: string): { stash: string; restoreDate: string } {
  return locale.startsWith("zh")
    ? { stash: "收纳", restoreDate: "设置恢复日期…" }
    : { stash: "Stash", restoreDate: "Set restore date…" };
}

const STASH_ICON_PATH =
  "M2.5 4.5h11M3.5 4.5v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7M2.5 2.5h11v2h-11zM6.5 7h3";

/** Revealed on hover; a span because a tab is already a button. */
export function createTabStashControl(
  doc: Document,
  target: TopTabsStashTarget,
  stash: TopTabsStash,
  locale: string,
): HTMLElement {
  const control = doc.createElement("span");
  control.className = "codexhost-session-tab-stash";
  control.setAttribute(TOP_TAB_STASH_ATTRIBUTE, "true");
  control.setAttribute("role", "button");
  const label = strings(locale).stash;
  control.setAttribute("aria-label", label);
  control.title = label;
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", STASH_ICON_PATH);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  control.appendChild(svg);
  control.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    stash.stash(target);
  });
  return control;
}

/** Opens the tab's right-click menu at the pointer; it closes on choice, Escape, or outside click. */
export function openTabContextMenu(input: {
  readonly doc: Document;
  readonly event: MouseEvent;
  readonly anchor: HTMLElement;
  readonly target: TopTabsStashTarget;
  readonly stash: TopTabsStash;
  readonly locale: string;
}): void {
  const { doc, event, anchor, target, stash } = input;
  closeTabContextMenu(doc);
  const text = strings(input.locale);
  const menu = doc.createElement("div");
  menu.setAttribute(TOP_TAB_CONTEXT_MENU_ATTRIBUTE, "true");
  menu.setAttribute("role", "menu");
  const item = (label: string, choose: () => void): HTMLButtonElement => {
    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.addEventListener("click", () => {
      closeTabContextMenu(doc);
      choose();
    });
    return button;
  };
  menu.append(
    item(text.stash, () => stash.stash(target)),
    item(text.restoreDate, () => stash.setRestoreDate(target, anchor)),
  );
  doc.body.appendChild(menu);
  const view = doc.defaultView;
  const width = view?.innerWidth ?? 1024;
  const height = view?.innerHeight ?? 768;
  menu.style.left = `${Math.min(Math.max(8, event.clientX), width - 200)}px`;
  menu.style.top = `${Math.min(Math.max(8, event.clientY), height - 96)}px`;

  const onPointerDown = (ev: Event): void => {
    if (ev.target instanceof Node && menu.contains(ev.target)) return;
    closeTabContextMenu(doc);
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") closeTabContextMenu(doc);
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  menuCleanups.set(menu, () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
  });
}

const menuCleanups = new WeakMap<Element, () => void>();

export function closeTabContextMenu(doc: Document): void {
  for (const menu of doc.querySelectorAll(`[${TOP_TAB_CONTEXT_MENU_ATTRIBUTE}]`)) {
    menuCleanups.get(menu)?.();
    menu.remove();
  }
}
