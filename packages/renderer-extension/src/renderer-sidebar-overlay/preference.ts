export const SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY = "codexhost.sidebar-auto-collapse.v1";
export const SIDEBAR_OVERLAY_MODE_STORAGE_KEY = "codexhost.sidebar-overlay-mode.v1";
export const SIDEBAR_OVERLAY_BREAKPOINT_STORAGE_KEY = "codexhost.sidebar-overlay-breakpoint.v1";
export const SIDEBAR_OVERLAY_PREFERENCE_CHANGE_EVENT =
  "codexhost:sidebar-overlay-preference-change";
export const SIDEBAR_AUTO_COLLAPSE_PREFERENCE_CHANGE_EVENT =
  SIDEBAR_OVERLAY_PREFERENCE_CHANGE_EVENT;

export const DEFAULT_SIDEBAR_AUTO_COLLAPSE = true;
export const DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT = 1080;

type StorageLike = Partial<Pick<Storage, "getItem" | "setItem" | "removeItem">>;

function defaultWindow(): Window | null {
  try {
    return typeof window !== "undefined" ? window : null;
  } catch {
    return null;
  }
}

function resolveStorage(owner: Window | StorageLike | null | undefined): StorageLike | null {
  if (!owner) return null;
  if (typeof (owner as StorageLike).getItem === "function" && !("document" in (owner as object))) {
    return owner as StorageLike;
  }
  try {
    return (owner as Window).localStorage ?? null;
  } catch {
    return null;
  }
}

export function parseSidebarAutoCollapsePreference(raw: string | null | undefined): boolean {
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (
    normalized === "docked" ||
    normalized === "false" ||
    normalized === "0" ||
    normalized === "off"
  ) {
    return false;
  }
  if (
    normalized === "auto" ||
    normalized === "overlay" ||
    normalized === "true" ||
    normalized === "1" ||
    normalized === "on"
  ) {
    return true;
  }
  return DEFAULT_SIDEBAR_AUTO_COLLAPSE;
}

export function readSidebarAutoCollapsePreference(
  owner: Window | StorageLike | null | undefined = defaultWindow(),
): boolean {
  const storage = resolveStorage(owner);
  if (!storage?.getItem) return DEFAULT_SIDEBAR_AUTO_COLLAPSE;
  try {
    const legacyRaw = storage.getItem(SIDEBAR_OVERLAY_MODE_STORAGE_KEY);
    if (legacyRaw !== null && legacyRaw !== undefined && legacyRaw.trim() !== "") {
      const migrated = parseSidebarAutoCollapsePreference(legacyRaw);
      try {
        storage.setItem?.(SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY, migrated ? "true" : "false");
        storage.removeItem?.(SIDEBAR_OVERLAY_MODE_STORAGE_KEY);
      } catch {
        // Ignore storage quota or private mode failures
      }
      return migrated;
    }
    const raw = storage.getItem(SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY);
    if (raw !== null && raw !== undefined && raw.trim() !== "") {
      return parseSidebarAutoCollapsePreference(raw);
    }
  } catch {
    // Fall through
  }
  return DEFAULT_SIDEBAR_AUTO_COLLAPSE;
}

export function writeSidebarAutoCollapsePreference(
  enabled: boolean,
  owner: Window | StorageLike | null | undefined = defaultWindow(),
  targetWindow?: Window | null,
): void {
  const storage = resolveStorage(owner);
  try {
    storage?.setItem?.(SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY, enabled ? "true" : "false");
    storage?.removeItem?.(SIDEBAR_OVERLAY_MODE_STORAGE_KEY);
  } catch {
    // Ignore storage quota or private mode failures
  }
  const win =
    targetWindow ??
    (owner && "document" in (owner as object) ? (owner as Window) : defaultWindow());
  try {
    win?.dispatchEvent?.(new Event(SIDEBAR_OVERLAY_PREFERENCE_CHANGE_EVENT));
  } catch {
    // Ignore event dispatch errors in minimal test DOMs
  }
}

export function setSidebarAutoCollapsePreference(ownerWindow: Window, enabled: boolean): void {
  writeSidebarAutoCollapsePreference(enabled, ownerWindow, ownerWindow);
}

export function readSidebarOverlayBreakpoint(
  owner: Window | StorageLike | null | undefined = defaultWindow(),
): number {
  const storage = resolveStorage(owner);
  try {
    const raw = storage?.getItem?.(SIDEBAR_OVERLAY_BREAKPOINT_STORAGE_KEY);
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 600 && parsed <= 2560) return parsed;
    }
  } catch {
    // Fall through
  }
  return DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT;
}

export function subscribeSidebarAutoCollapsePreference(
  targetWindow: Window,
  listener: () => void,
): () => void {
  const handleStorage = (event: StorageEvent): void => {
    if (
      !event.key ||
      event.key === SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY ||
      event.key === SIDEBAR_OVERLAY_MODE_STORAGE_KEY ||
      event.key === SIDEBAR_OVERLAY_BREAKPOINT_STORAGE_KEY
    ) {
      listener();
    }
  };
  targetWindow.addEventListener("storage", handleStorage);
  targetWindow.addEventListener(SIDEBAR_OVERLAY_PREFERENCE_CHANGE_EVENT, listener);
  return () => {
    targetWindow.removeEventListener("storage", handleStorage);
    targetWindow.removeEventListener(SIDEBAR_OVERLAY_PREFERENCE_CHANGE_EVENT, listener);
  };
}

export const subscribeSidebarOverlayPreference = subscribeSidebarAutoCollapsePreference;
