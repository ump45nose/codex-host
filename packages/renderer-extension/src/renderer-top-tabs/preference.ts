export const TOP_TABS_ENABLED_STORAGE_KEY = "codexhost.top-tabs-enabled.v1";
export const TOP_TABS_PREFERENCE_CHANGE_EVENT = "codexhost:top-tabs-preference-change";
export const DEFAULT_TOP_TABS_ENABLED = true;
export const TOP_TABS_TWO_ROWS_STORAGE_KEY = "codexhost.top-tabs-two-rows.v1";
export const DEFAULT_TOP_TABS_TWO_ROWS = true;

type StorageLike = Partial<Pick<Storage, "getItem" | "setItem">>;

function resolveStorage(owner?: Window | StorageLike | null): StorageLike | null {
  try {
    const target = owner ?? (typeof window !== "undefined" ? window : null);
    if (!target) return null;
    return "getItem" in target && !("document" in target)
      ? target
      : ((target as Window).localStorage ?? null);
  } catch {
    return null;
  }
}

function readFlag(owner: Window | StorageLike | null | undefined, key: string, fallback: boolean) {
  try {
    const raw = resolveStorage(owner)?.getItem?.(key);
    return raw === "0" || raw === "false" ? false : raw === "1" || raw === "true" ? true : fallback;
  } catch {
    return fallback;
  }
}

export function readTopTabsEnabledPreference(owner?: Window | StorageLike | null): boolean {
  return readFlag(owner, TOP_TABS_ENABLED_STORAGE_KEY, DEFAULT_TOP_TABS_ENABLED);
}

/** Whether the strip may wrap onto a second row of five tabs before collapsing into "+N". */
export function readTopTabsTwoRowsPreference(owner?: Window | StorageLike | null): boolean {
  return readFlag(owner, TOP_TABS_TWO_ROWS_STORAGE_KEY, DEFAULT_TOP_TABS_TWO_ROWS);
}

export function writeTopTabsEnabledPreference(
  enabled: boolean,
  owner?: Window | StorageLike | null,
  targetWindow?: Window | null,
): void {
  writeFlag(TOP_TABS_ENABLED_STORAGE_KEY, enabled, owner, targetWindow);
}

function writeFlag(
  key: string,
  value: boolean,
  owner?: Window | StorageLike | null,
  targetWindow?: Window | null,
): void {
  try {
    resolveStorage(owner)?.setItem?.(key, value ? "1" : "0");
    const win =
      targetWindow ??
      (owner && "document" in owner
        ? (owner as Window)
        : typeof window !== "undefined"
          ? window
          : null);
    win?.dispatchEvent?.(new Event(TOP_TABS_PREFERENCE_CHANGE_EVENT));
  } catch {
    // Ignore storage/event errors
  }
}

export function setTopTabsEnabledPreference(ownerWindow: Window, enabled: boolean): void {
  writeTopTabsEnabledPreference(enabled, ownerWindow, ownerWindow);
}

export function setTopTabsTwoRowsPreference(ownerWindow: Window, twoRows: boolean): void {
  writeFlag(TOP_TABS_TWO_ROWS_STORAGE_KEY, twoRows, ownerWindow, ownerWindow);
}

export function subscribeTopTabsPreference(targetWindow: Window, listener: () => void): () => void {
  const onStorage = (e: StorageEvent): void => {
    if (!e.key || e.key === TOP_TABS_ENABLED_STORAGE_KEY || e.key === TOP_TABS_TWO_ROWS_STORAGE_KEY)
      listener();
  };
  targetWindow.addEventListener("storage", onStorage);
  targetWindow.addEventListener(TOP_TABS_PREFERENCE_CHANGE_EVENT, listener);
  return () => {
    targetWindow.removeEventListener("storage", onStorage);
    targetWindow.removeEventListener(TOP_TABS_PREFERENCE_CHANGE_EVENT, listener);
  };
}
