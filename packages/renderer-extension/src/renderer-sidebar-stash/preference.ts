/** Sidebar stash enable preference. Default ON when unset. */

export const SIDEBAR_STASH_ENABLED_STORAGE_KEY = "codexhost.sidebar-stash.enabled";
export const SIDEBAR_STASH_ENABLED_CHANGE_EVENT = "codexhost:sidebar-stash-enabled-changed";

export type SidebarStashEnabledPreference = boolean;

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "getItem" | "setItem">;

export function readSidebarStashEnabledPreference(
  owner: Window | StorageReader | null | undefined = defaultWindow(),
): SidebarStashEnabledPreference {
  const storage = storageReaderOf(owner);
  if (!storage) return true;
  try {
    const raw = storage.getItem(SIDEBAR_STASH_ENABLED_STORAGE_KEY);
    if (raw === null || raw === undefined || raw === "") return true;
    if (raw === "0" || raw === "false") return false;
    if (raw === "1" || raw === "true") return true;
    return true;
  } catch {
    return true;
  }
}

export function writeSidebarStashEnabledPreference(
  value: SidebarStashEnabledPreference,
  owner: Window | StorageWriter | null | undefined = defaultWindow(),
): void {
  const storage = storageWriterOf(owner);
  if (storage) {
    try {
      storage.setItem(SIDEBAR_STASH_ENABLED_STORAGE_KEY, value ? "1" : "0");
    } catch {
      /* ignore */
    }
  }
  if (owner && typeof (owner as Window).dispatchEvent === "function") {
    (owner as Window).dispatchEvent(new Event(SIDEBAR_STASH_ENABLED_CHANGE_EVENT));
  }
}

export function setSidebarStashEnabledPreference(
  ownerWindow: Window,
  value: SidebarStashEnabledPreference,
): void {
  writeSidebarStashEnabledPreference(value, ownerWindow);
}

export function subscribeSidebarStashEnabledPreference(
  ownerWindow: Window,
  listener: () => void,
): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === SIDEBAR_STASH_ENABLED_STORAGE_KEY || event.key === null) listener();
  };
  ownerWindow.addEventListener(SIDEBAR_STASH_ENABLED_CHANGE_EVENT, listener);
  ownerWindow.addEventListener("storage", onStorage);
  return () => {
    ownerWindow.removeEventListener(SIDEBAR_STASH_ENABLED_CHANGE_EVENT, listener);
    ownerWindow.removeEventListener("storage", onStorage);
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
