export const TOP_TABS_ENABLED_STORAGE_KEY = "codexhost.top-tabs-enabled.v1";
export const TOP_TABS_MAX_VISIBLE_STORAGE_KEY = "codexhost.top-tabs-max-visible.v1";
export const TOP_TABS_STATE_STORAGE_KEY = "codexhost.top-tabs-state.v1";
export const TOP_TABS_PREFERENCE_CHANGE_EVENT = "codexhost:top-tabs-preference-change";

export const DEFAULT_TOP_TABS_ENABLED = true;
export const DEFAULT_TOP_TABS_MAX_VISIBLE = 4;

export interface TopTabPersistedItem {
  readonly hostId: string;
  readonly threadId: string;
  readonly pinned?: boolean;
  readonly title?: string;
}

export interface TopTabsPersistedState {
  readonly version: 1;
  readonly items: readonly TopTabPersistedItem[];
}

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "getItem" | "setItem">;

export function readTopTabsEnabledPreference(
  owner: Window | StorageReader | null | undefined = defaultWindow(),
): boolean {
  const storage = storageReaderOf(owner);
  if (!storage) return DEFAULT_TOP_TABS_ENABLED;
  try {
    const raw = storage.getItem(TOP_TABS_ENABLED_STORAGE_KEY);
    if (raw === null || raw === undefined || raw === "") return DEFAULT_TOP_TABS_ENABLED;
    if (raw === "0" || raw === "false") return false;
    if (raw === "1" || raw === "true") return true;
    return DEFAULT_TOP_TABS_ENABLED;
  } catch {
    return DEFAULT_TOP_TABS_ENABLED;
  }
}

export function writeTopTabsEnabledPreference(
  enabled: boolean,
  owner: Window | StorageWriter | null | undefined = defaultWindow(),
  targetWindow?: Window | null,
): void {
  const storage = storageWriterOf(owner);
  if (storage) {
    try {
      storage.setItem(TOP_TABS_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      // Ignore storage errors
    }
  }
  const win =
    targetWindow ??
    (owner && "document" in (owner as object) ? (owner as Window) : defaultWindow());
  dispatchTopTabsPreferenceChange(win);
}

export function setTopTabsEnabledPreference(ownerWindow: Window, enabled: boolean): void {
  writeTopTabsEnabledPreference(enabled, ownerWindow, ownerWindow);
}

export function readTopTabsMaxVisible(
  owner: Window | StorageReader | null | undefined = defaultWindow(),
): number {
  const storage = storageReaderOf(owner);
  if (!storage) return DEFAULT_TOP_TABS_MAX_VISIBLE;
  try {
    const raw = storage.getItem(TOP_TABS_MAX_VISIBLE_STORAGE_KEY);
    if (!raw) return DEFAULT_TOP_TABS_MAX_VISIBLE;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 3 && parsed <= 5) {
      return parsed;
    }
  } catch {
    // Fall through
  }
  return DEFAULT_TOP_TABS_MAX_VISIBLE;
}

export function writeTopTabsMaxVisible(
  count: number,
  owner: Window | StorageWriter | null | undefined = defaultWindow(),
  targetWindow?: Window | null,
): void {
  const normalized = Math.max(3, Math.min(5, Math.round(count)));
  const storage = storageWriterOf(owner);
  if (storage) {
    try {
      storage.setItem(TOP_TABS_MAX_VISIBLE_STORAGE_KEY, String(normalized));
    } catch {
      // Ignore storage errors
    }
  }
  const win =
    targetWindow ??
    (owner && "document" in (owner as object) ? (owner as Window) : defaultWindow());
  dispatchTopTabsPreferenceChange(win);
}

export function readTopTabsPersistedState(
  owner: Window | StorageReader | null | undefined = defaultWindow(),
): TopTabsPersistedState {
  const storage = storageReaderOf(owner);
  if (!storage) return { version: 1, items: [] };
  try {
    const raw = storage.getItem(TOP_TABS_STATE_STORAGE_KEY);
    if (!raw) return { version: 1, items: [] };
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { items?: unknown }).items)
    ) {
      return { version: 1, items: [] };
    }
    const seen = new Set<string>();
    const items: TopTabPersistedItem[] = [];
    for (const rawItem of (parsed as { items: unknown[] }).items) {
      if (typeof rawItem !== "object" || rawItem === null) continue;
      const hostId = (rawItem as { hostId?: unknown }).hostId;
      const threadId = (rawItem as { threadId?: unknown }).threadId;
      const pinned = (rawItem as { pinned?: unknown }).pinned;
      const title = (rawItem as { title?: unknown }).title;
      if (
        typeof hostId !== "string" ||
        hostId.length === 0 ||
        typeof threadId !== "string" ||
        threadId.length === 0
      ) {
        continue;
      }
      const key = `${hostId}:${threadId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        hostId,
        threadId,
        ...(typeof pinned === "boolean" ? { pinned } : {}),
        ...(typeof title === "string" && title.length > 0 ? { title } : {}),
      });
    }
    return { version: 1, items };
  } catch {
    return { version: 1, items: [] };
  }
}

export function writeTopTabsPersistedState(
  state: TopTabsPersistedState,
  owner: Window | StorageWriter | null | undefined = defaultWindow(),
): void {
  const storage = storageWriterOf(owner);
  if (!storage) return;
  try {
    storage.setItem(TOP_TABS_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

function dispatchTopTabsPreferenceChange(targetWindow?: Window | null): void {
  const win = targetWindow ?? defaultWindow();
  if (!win || typeof win.dispatchEvent !== "function") return;
  try {
    win.dispatchEvent(new Event(TOP_TABS_PREFERENCE_CHANGE_EVENT));
  } catch {
    // Ignore dispatch errors
  }
}

export function subscribeTopTabsPreference(targetWindow: Window, listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (
      !event.key ||
      event.key === TOP_TABS_ENABLED_STORAGE_KEY ||
      event.key === TOP_TABS_MAX_VISIBLE_STORAGE_KEY ||
      event.key === TOP_TABS_STATE_STORAGE_KEY
    ) {
      listener();
    }
  };
  targetWindow.addEventListener("storage", onStorage);
  targetWindow.addEventListener(TOP_TABS_PREFERENCE_CHANGE_EVENT, listener);
  return () => {
    targetWindow.removeEventListener("storage", onStorage);
    targetWindow.removeEventListener(TOP_TABS_PREFERENCE_CHANGE_EVENT, listener);
  };
}

function storageReaderOf(owner: Window | StorageReader | null | undefined): StorageReader | null {
  if (!owner) return null;
  if (
    typeof (owner as StorageReader).getItem === "function" &&
    !("document" in (owner as object))
  ) {
    return owner as StorageReader;
  }
  try {
    return (owner as Window).localStorage ?? null;
  } catch {
    return null;
  }
}

function storageWriterOf(owner: Window | StorageWriter | null | undefined): StorageWriter | null {
  if (!owner) return null;
  if (
    typeof (owner as StorageWriter).getItem === "function" &&
    typeof (owner as StorageWriter).setItem === "function" &&
    !("document" in (owner as object))
  ) {
    return owner as StorageWriter;
  }
  try {
    return (owner as Window).localStorage ?? null;
  } catch {
    return null;
  }
}

function defaultWindow(): Window | null {
  try {
    return typeof window !== "undefined" ? window : null;
  } catch {
    return null;
  }
}
