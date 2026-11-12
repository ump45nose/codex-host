import { dueAtFromDateInput, dueAtFromPreset, type StashDatePreset } from "./dates.js";
import type { StashUiStrings } from "./strings.js";

export interface DuePopoverOptions {
  document?: Document;
  strings: StashUiStrings;
  currentDueAt?: string | null;
  anchor: DOMRect | { getBoundingClientRect(): DOMRect };
  onSelect: (dueAt: string | null) => void;
  onClose?: () => void;
}

export interface DuePopoverHandle {
  root: HTMLElement;
  close(): void;
}

export function openDuePopover(options: DuePopoverOptions): DuePopoverHandle {
  const doc = options.document ?? document;
  const root = doc.createElement("div");
  root.setAttribute("data-codexhost-sidebar-stash-popover", "1");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", options.strings.duePopoverTitle);

  const title = doc.createElement("h2");
  title.textContent = options.strings.duePopoverTitle;
  root.appendChild(title);

  const presets = doc.createElement("div");
  presets.className = "codexhost-stash-presets";
  const presetDefs: Array<{
    id: StashDatePreset | "clear";
    label: string;
    due: () => string | null;
  }> = [
    { id: "tomorrow", label: options.strings.dueTomorrow, due: () => dueAtFromPreset("tomorrow") },
    { id: "in3days", label: options.strings.dueIn3Days, due: () => dueAtFromPreset("in3days") },
    {
      id: "nextMonday",
      label: options.strings.dueNextMonday,
      due: () => dueAtFromPreset("nextMonday"),
    },
    { id: "clear", label: options.strings.dueClear, due: () => null },
  ];
  for (const preset of presetDefs) {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = preset.label;
    button.addEventListener("click", () => {
      options.onSelect(preset.due());
      close();
    });
    presets.appendChild(button);
  }
  root.appendChild(presets);

  const custom = doc.createElement("div");
  custom.className = "codexhost-stash-custom";
  const input = doc.createElement("input");
  input.type = "date";
  if (options.currentDueAt) {
    const date = new Date(options.currentDueAt);
    if (!Number.isNaN(date.getTime())) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      input.value = `${y}-${m}-${d}`;
    }
  }
  custom.appendChild(input);
  root.appendChild(custom);

  const actions = doc.createElement("div");
  actions.className = "codexhost-stash-actions";
  const apply = doc.createElement("button");
  apply.type = "button";
  apply.textContent = options.strings.dueApply;
  apply.addEventListener("click", () => {
    if (!input.value) return;
    try {
      options.onSelect(dueAtFromDateInput(input.value));
      close();
    } catch {
      input.focus();
    }
  });
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.textContent = options.strings.dueCancel;
  cancel.addEventListener("click", () => close());
  actions.append(apply, cancel);
  root.appendChild(actions);

  const anchorRect =
    typeof (options.anchor as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect ===
    "function"
      ? (options.anchor as { getBoundingClientRect(): DOMRect }).getBoundingClientRect()
      : (options.anchor as DOMRect);
  doc.body.appendChild(root);
  const width = root.offsetWidth || 220;
  const height = root.offsetHeight || 200;
  const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - width - 8);
  const top = Math.min(Math.max(8, anchorRect.bottom + 6), window.innerHeight - height - 8);
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  const onPointer = (event: MouseEvent): void => {
    if (event.target instanceof Node && root.contains(event.target)) return;
    close();
  };
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("mousedown", onPointer, true);

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("mousedown", onPointer, true);
    root.remove();
    options.onClose?.();
  }

  return { root, close };
}
