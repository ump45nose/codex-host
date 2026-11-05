import { isDue } from "./dates.js";
import type { StashItem } from "./state.js";

export interface SortedStashEntry {
  threadId: string;
  item: StashItem;
  overdue: boolean;
}

/** Overdue first (soonest first), then the rest newest-stashed first. */
export function sortedEntries(
  items: Record<string, StashItem>,
  clock = Date.now(),
): SortedStashEntry[] {
  const overdue: SortedStashEntry[] = [];
  const rest: SortedStashEntry[] = [];
  for (const [threadId, item] of Object.entries(items)) {
    const entry: SortedStashEntry = { threadId, item, overdue: isDue(item.dueAt, clock) };
    (entry.overdue ? overdue : rest).push(entry);
  }
  overdue.sort((a, b) => {
    const left = a.item.dueAt ? Date.parse(a.item.dueAt) : 0;
    const right = b.item.dueAt ? Date.parse(b.item.dueAt) : 0;
    return left - right || a.threadId.localeCompare(b.threadId);
  });
  rest.sort(
    (a, b) =>
      Date.parse(b.item.stashedAt) - Date.parse(a.item.stashedAt) ||
      a.threadId.localeCompare(b.threadId),
  );
  return overdue.concat(rest);
}
