export type SidebarOverlayMode = "auto" | "overlay" | "docked";

export const SIDEBAR_OVERLAY_MODES = ["auto", "overlay", "docked"] as const;
export const SIDEBAR_OVERLAY_MODE_STORAGE_KEY = "codexhost.sidebar-overlay-mode.v1";
export const SIDEBAR_OVERLAY_BREAKPOINT_STORAGE_KEY = "codexhost.sidebar-overlay-breakpoint.v1";
export const SIDEBAR_OVERLAY_DWELL_MS_STORAGE_KEY = "codexhost.sidebar-overlay-dwell-ms.v1";
export const SIDEBAR_OVERLAY_PREFERENCE_CHANGE_EVENT =
  "codexhost:sidebar-overlay-preference-change";

export const DEFAULT_SIDEBAR_OVERLAY_MODE: SidebarOverlayMode = "auto";
export const DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT = 1080;
export const DEFAULT_SIDEBAR_OVERLAY_DWELL_MS = 200;
export const DEFAULT_SIDEBAR_OVERLAY_LEAVE_MS = 300;

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "getItem" | "setItem">;

export function isSidebarOverlayMode(value: unknown): value is SidebarOverlayMode {
  return (SIDEBAR_OVERLAY_MODES as readonly unknown[]).includes(value);
}

export function parseSidebarOverlayMode(raw: string | null | undefined): SidebarOverlayMode {
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (normalized === "overlay" || normalized === "docked" || normalized === "auto") {
    return normalized;
  }
  return DEFAULT_SIDEBAR_OVERLAY_MODE;
}

export function readSidebarOverlayMode(
  owner: Window | StorageReader | null | undefined = defaultWindow(),
): SidebarOverlayMode {
  const storage = storageReaderOf(owner);
  if (!storage) {
    return DEFAULT_SIDEBAR_OVERLAY_MODE;
  }
  try {
    return parseSidebarOverlayMode(storage.getItem(SIDEBAR_OVERLAY_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_SIDEBAR_OVERLAY_MODE;
  }
}

export function writeSidebarOverlayMode(
  mode: SidebarOverlayMode,
  owner: Window | StorageWriter | null | undefined = defaultWindow(),
  targetWindow?: Window | null,
): void {
  const storage = storageWriterOf(owner);
  if (storage) {
    try {
      storage.setItem(SIDEBAR_OVERLAY_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage quota or private mode failures
    }
  }
  const win =
    targetWindow ??
    (owner && "document" in (owner as object) ? (owner as Window) : defaultWindow());
  dispatchSidebarOverlayPreferenceChange(win);
}

export function setSidebarOverlayMode(ownerWindow: Window, mode: SidebarOverlayMode): void {
  writeSidebarOverlayMode(mode, ownerWindow, ownerWindow);
}

export function readSidebarOverlayBreakpoint(
  owner: Window | StorageReader | null | undefined = defaultWindow(),
): number {
  const storage = storageReaderOf(owner);
  if (!storage) {
    return DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT;
  }
  try {
    const raw = storage.getItem(SIDEBAR_OVERLAY_BREAKPOINT_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 600 && parsed <= 2560) {
      return parsed;
    }
  } catch {
    // Fall through
  }
  return DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT;
}

export function writeSidebarOverlayBreakpoint(
  breakpoint: number,
  owner: Window | StorageWriter | null | undefined = defaultWindow(),
  targetWindow?: Window | null,
): void {
  const normalized = Math.max(600, Math.min(2560, Math.round(breakpoint)));
  const storage = storageWriterOf(owner);
  if (storage) {
    try {
      storage.setItem(SIDEBAR_OVERLAY_BREAKPOINT_STORAGE_KEY, String(normalized));
    } catch {
      // Ignore storage failures
    }
  }
  const win =
    targetWindow ??
    (owner && "document" in (owner as object) ? (owner as Window) : defaultWindow());
  dispatchSidebarOverlayPreferenceChange(win);
}

export function readSidebarOverlayDwellMs(
  owner: Window | StorageReader | null | undefined = defaultWindow(),
): number {
  const storage = storageReaderOf(owner);
  if (!storage) {
    return DEFAULT_SIDEBAR_OVERLAY_DWELL_MS;
  }
  try {
    const raw = storage.getItem(SIDEBAR_OVERLAY_DWELL_MS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SIDEBAR_OVERLAY_DWELL_MS;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 50 && parsed <= 1000) {
      return parsed;
    }
  } catch {
    // Fall through
  }
  return DEFAULT_SIDEBAR_OVERLAY_DWELL_MS;
}

export function resolveSidebarOverlayEffective(options: {
  readonly mode: SidebarOverlayMode;
  readonly viewportWidth: number;
  readonly breakpoint?: number;
}): boolean {
  const breakpoint = options.breakpoint ?? DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT;
  if (options.mode === "overlay") {
    return true;
  }
  if (options.mode === "docked") {
    return false;
  }
  return options.viewportWidth > 0 && options.viewportWidth < breakpoint;
}

function dispatchSidebarOverlayPreferenceChange(targetWindow?: Window | null): void {
  const win = targetWindow ?? defaultWindow();
  if (!win || typeof win.dispatchEvent !== "function") {
    return;
  }
  try {
    win.dispatchEvent(new Event(SIDEBAR_OVERLAY_PREFERENCE_CHANGE_EVENT));
  } catch {
    // Ignore event dispatch errors in minimal test DOMs
  }
}

export function subscribeSidebarOverlayPreference(
  targetWindow: Window,
  listener: () => void,
): () => void {
  const handleStorage = (event: StorageEvent): void => {
    if (
      !event.key ||
      event.key === SIDEBAR_OVERLAY_MODE_STORAGE_KEY ||
      event.key === SIDEBAR_OVERLAY_BREAKPOINT_STORAGE_KEY ||
      event.key === SIDEBAR_OVERLAY_DWELL_MS_STORAGE_KEY
    ) {
      listener();
    }
  };
  const handleCustom = (): void => {
    listener();
  };
  targetWindow.addEventListener("storage", handleStorage);
  targetWindow.addEventListener(SIDEBAR_OVERLAY_PREFERENCE_CHANGE_EVENT, handleCustom);
  return () => {
    targetWindow.removeEventListener("storage", handleStorage);
    targetWindow.removeEventListener(SIDEBAR_OVERLAY_PREFERENCE_CHANGE_EVENT, handleCustom);
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
