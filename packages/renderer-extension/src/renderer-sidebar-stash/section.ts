import { formatDueLabel } from "./format.js";
import { sortedEntries } from "./sort.js";
import type { StashState } from "./state.js";
import type { StashUiStrings } from "./strings.js";

export interface StashSectionOptions {
  document?: Document;
  strings: StashUiStrings;
  locale?: string;
  onOpen: (threadId: string) => void;
  onContextMenu?: (threadId: string, event: MouseEvent, anchor: HTMLElement) => void;
}

export interface StashSectionHandle {
  root: HTMLElement;
  render(state: StashState, clock?: number): void;
  dispose(): void;
}

export function createStashSection(options: StashSectionOptions): StashSectionHandle {
  const doc = options.document ?? document;
  const locale = options.locale ?? "zh-CN";
  const root = doc.createElement("section");
  root.setAttribute("data-codexhost-sidebar-stash-root", "1");

  const header = doc.createElement("div");
  header.setAttribute("data-codexhost-sidebar-stash-header", "1");
  const title = doc.createElement("span");
  title.textContent = options.strings.sectionTitle;
  const count = doc.createElement("span");
  count.setAttribute("data-codexhost-sidebar-stash-count", "1");
  header.append(title, count);
  root.appendChild(header);

  const list = doc.createElement("ul");
  list.setAttribute("data-codexhost-sidebar-stash-list", "1");
  root.appendChild(list);

  const empty = doc.createElement("div");
  empty.setAttribute("data-codexhost-sidebar-stash-empty", "1");
  empty.textContent = options.strings.sectionEmpty;
  empty.hidden = true;
  root.appendChild(empty);

  function render(state: StashState, clock = Date.now()): void {
    const entries = sortedEntries(state.items ?? {}, clock);
    count.textContent = String(entries.length);
    list.replaceChildren();
    empty.hidden = entries.length > 0;
    for (const entry of entries) {
      const li = doc.createElement("li");
      const row = doc.createElement("button");
      row.type = "button";
      row.setAttribute("data-codexhost-sidebar-stash-row", "1");
      row.setAttribute("data-thread-id", entry.threadId);
      if (entry.overdue) row.setAttribute("data-overdue", "1");
      const titleEl = doc.createElement("span");
      titleEl.setAttribute("data-codexhost-sidebar-stash-title", "1");
      titleEl.textContent = entry.item.title || "Untitled";
      row.appendChild(titleEl);
      if (entry.overdue) {
        const badge = doc.createElement("span");
        badge.setAttribute("data-codexhost-sidebar-stash-badge", "1");
        badge.textContent = options.strings.badgeDue;
        row.appendChild(badge);
      } else if (entry.item.dueAt) {
        const due = doc.createElement("span");
        due.setAttribute("data-codexhost-sidebar-stash-due", "1");
        due.textContent = formatDueLabel(entry.item.dueAt, locale);
        row.appendChild(due);
      }
      row.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onOpen(entry.threadId);
      });
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onContextMenu?.(entry.threadId, event, row);
      });
      li.appendChild(row);
      list.appendChild(li);
    }
  }

  return {
    root,
    render,
    dispose() {
      root.remove();
    },
  };
}
