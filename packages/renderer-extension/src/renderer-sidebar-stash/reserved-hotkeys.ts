/**
 * Registry of hotkeys claimed by CodexHost renderer features.
 * Other extensions should consult this before binding Mod+Shift chords.
 */

export interface ReservedHotkey {
  id: string;
  chord: string;
  description: string;
}

const GLOBAL_KEY = "__codexHostReservedHotkeys";

type ReservedHotkeyGlobal = typeof globalThis & {
  [GLOBAL_KEY]?: ReservedHotkey[];
};

export const STASH_RESERVED_HOTKEYS: readonly ReservedHotkey[] = Object.freeze([
  {
    id: "sidebar-stash.stash",
    chord: "Mod+Shift+H",
    description: "Stash / unstash current thread",
  },
  { id: "sidebar-stash.due", chord: "Mod+Shift+D", description: "Set stash resume date" },
  {
    id: "sidebar-stash.jump",
    chord: "Mod+Shift+J",
    description: "Jump to first overdue stash item",
  },
]);

export function registerReservedHotkeys(entries: readonly ReservedHotkey[]): () => void {
  const root = globalThis as ReservedHotkeyGlobal;
  const list = root[GLOBAL_KEY] ?? (root[GLOBAL_KEY] = []);
  for (const entry of entries) {
    if (!list.some((item) => item.id === entry.id)) list.push({ ...entry });
  }
  return () => {
    const current = root[GLOBAL_KEY];
    if (!current) return;
    for (const entry of entries) {
      const index = current.findIndex((item) => item.id === entry.id);
      if (index >= 0) current.splice(index, 1);
    }
  };
}

export function listReservedHotkeys(): readonly ReservedHotkey[] {
  const root = globalThis as ReservedHotkeyGlobal;
  return Object.freeze([...(root[GLOBAL_KEY] ?? [])]);
}
