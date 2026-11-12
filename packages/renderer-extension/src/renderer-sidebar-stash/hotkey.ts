/** Keyboard helpers for stash shortcuts. */

export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el !== "object") return false;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  const role = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
  return role === "textbox" || role === "searchbox" || role === "combobox";
}

export function matchChord(
  event: KeyboardEvent,
  chord: { key: string; shift?: boolean; alt?: boolean },
): boolean {
  if (!event || typeof event !== "object") return false;
  if (event.isComposing || event.repeat) return false;
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return false;
  if (Boolean(chord.shift) !== Boolean(event.shiftKey)) return false;
  if (Boolean(chord.alt) !== Boolean(event.altKey)) return false;
  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  const code = typeof event.code === "string" ? event.code.toLowerCase() : "";
  const want = chord.key.toLowerCase();
  return key === want || code === `key${want}`;
}

export const CHORDS = {
  stash: { key: "h", shift: true },
  due: { key: "d", shift: true },
  jump: { key: "j", shift: true },
} as const;

export type StashChordName = keyof typeof CHORDS;
