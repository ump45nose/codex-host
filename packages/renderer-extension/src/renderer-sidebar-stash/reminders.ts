import { isDue } from "./dates.js";
import type { StashState } from "./state.js";

export interface ReminderPort {
  permission?: NotificationPermission | string;
  requestPermission?: () =>
    Promise<NotificationPermission | string> | NotificationPermission | string;
  notify?: (title: string, options?: NotificationOptions) => unknown;
}

export interface ReminderStrings {
  overdueTitle?: string | ((count: number) => string);
  overdueBody?: string | ((titles: string[]) => string);
}

export interface ReminderController {
  sync(state: StashState): void;
  dispose(): void;
}

/**
 * Fire at most one Notification per overdue threadId per page lifetime.
 * Permission is requested once, lazily, the first time something is overdue.
 */
export function createReminderController(
  NotificationImpl: ReminderPort | null | undefined,
  options: { strings?: ReminderStrings; clock?: () => number } = {},
): ReminderController {
  const fired = new Set<string>();
  let disposed = false;
  let permissionPromise: Promise<boolean> | null = null;
  const clock = options.clock ?? (() => Date.now());
  const strings = options.strings ?? {};

  async function ensurePermission(): Promise<boolean> {
    if (!NotificationImpl) return false;
    if (NotificationImpl.permission === "granted") return true;
    if (NotificationImpl.permission === "denied") return false;
    if (!permissionPromise) {
      permissionPromise = Promise.resolve()
        .then(() =>
          typeof NotificationImpl.requestPermission === "function"
            ? NotificationImpl.requestPermission()
            : NotificationImpl.permission,
        )
        .then((result) => result === "granted")
        .catch(() => false);
    }
    return permissionPromise;
  }

  function sync(state: StashState): void {
    if (disposed || !state?.items) return;
    const now = clock();
    const newly: Array<{ threadId: string; title: string }> = [];
    for (const [threadId, item] of Object.entries(state.items)) {
      if (!isDue(item.dueAt, now)) continue;
      if (fired.has(threadId)) continue;
      fired.add(threadId);
      newly.push({ threadId, title: item.title || "Untitled" });
    }
    if (!newly.length) return;
    void ensurePermission().then((ok) => {
      if (!ok || disposed || typeof NotificationImpl?.notify !== "function") return;
      const titles = newly.map((entry) => entry.title);
      const title =
        typeof strings.overdueTitle === "function"
          ? strings.overdueTitle(newly.length)
          : (strings.overdueTitle ??
            (newly.length === 1 ? "收纳箱：有会话到期" : `收纳箱：${newly.length} 个会话到期`));
      const body =
        typeof strings.overdueBody === "function"
          ? strings.overdueBody(titles)
          : (strings.overdueBody ?? titles.slice(0, 3).join("、") + (titles.length > 3 ? "…" : ""));
      try {
        NotificationImpl.notify(title, { body, tag: "codexhost-sidebar-stash-overdue" });
      } catch {
        /* ignore */
      }
    });
  }

  return {
    sync,
    dispose() {
      disposed = true;
      fired.clear();
    },
  };
}

export function browserNotificationPort(
  NotificationCtor: typeof Notification | undefined = typeof Notification !== "undefined"
    ? Notification
    : undefined,
): ReminderPort | null {
  if (!NotificationCtor) return null;
  return {
    get permission() {
      return NotificationCtor.permission;
    },
    requestPermission: () => NotificationCtor.requestPermission(),
    notify: (title, options) => new NotificationCtor(title, options),
  };
}
