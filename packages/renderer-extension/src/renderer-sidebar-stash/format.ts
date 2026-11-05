/** Display helpers for stash due dates. */

export function formatDueLabel(
  dueAt: string | null | undefined,
  locale = "zh-CN",
  now = new Date(),
): string {
  if (!dueAt) return "";
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return "";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDue = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const deltaDays = Math.round((startOfDue.getTime() - startOfToday.getTime()) / dayMs);
  if (deltaDays === 0) return locale.startsWith("zh") ? "今天" : "Today";
  if (deltaDays === 1) return locale.startsWith("zh") ? "明天" : "Tomorrow";
  if (deltaDays === -1) return locale.startsWith("zh") ? "昨天" : "Yesterday";
  if (deltaDays > 1 && deltaDays < 7) {
    return due.toLocaleDateString(locale, { weekday: "short" });
  }
  return due.toLocaleDateString(locale, { month: "short", day: "numeric" });
}
