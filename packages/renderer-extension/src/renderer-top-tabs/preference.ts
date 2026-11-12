export const TOP_TABS_ENABLED_STORAGE_KEY = "codexhost.top-tabs-enabled.v1";
export const TOP_TABS_PREFERENCE_CHANGE_EVENT = "codexhost:top-tabs-preference-change";
export const DEFAULT_TOP_TABS_ENABLED = true;

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

export function readTopTabsEnabledPreference(owner?: Window | StorageLike | null): boolean {
  try {
    const raw = resolveStorage(owner)?.getItem?.(TOP_TABS_ENABLED_STORAGE_KEY);
    return raw === "0" || raw === "false" ? false : DEFAULT_TOP_TABS_ENABLED;
  } catch {
    return DEFAULT_TOP_TABS_ENABLED;
  }
}

export function writeTopTabsEnabledPreference(
  enabled: boolean,
  owner?: Window | StorageLike | null,
  targetWindow?: Window | null,
): void {
  try {
    resolveStorage(owner)?.setItem?.(TOP_TABS_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
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

export function subscribeTopTabsPreference(targetWindow: Window, listener: () => void): () => void {
  const onStorage = (e: StorageEvent): void => {
    if (!e.key || e.key === TOP_TABS_ENABLED_STORAGE_KEY) listener();
  };
  targetWindow.addEventListener("storage", onStorage);
  targetWindow.addEventListener(TOP_TABS_PREFERENCE_CHANGE_EVENT, listener);
  return () => {
    targetWindow.removeEventListener("storage", onStorage);
    targetWindow.removeEventListener(TOP_TABS_PREFERENCE_CHANGE_EVENT, listener);
  };
}
