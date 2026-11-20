export const STYLE_ATTR = "data-codexhost-sidebar-stash-style";

export const STYLES = `
[data-codexhost-sidebar-stash-root] {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  align-self: stretch;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  gap: 2px;
  padding: 4px 8px 8px;
  margin: 0;
}
[data-codexhost-sidebar-stash-header] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 4px 2px;
  color: var(--color-token-text-secondary, #8b8b8b);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.02em;
  user-select: none;
}
[data-codexhost-sidebar-stash-count] {
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}
[data-codexhost-sidebar-stash-list] {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[data-codexhost-sidebar-stash-empty] {
  padding: 6px 4px;
  color: var(--color-token-text-tertiary, #a0a0a0);
  font-size: 12px;
}
[data-codexhost-sidebar-stash-row] {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin: 0;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
[data-codexhost-sidebar-stash-row]:hover {
  background: var(--color-token-bg-hover, rgba(127, 127, 127, 0.12));
}
[data-codexhost-sidebar-stash-row][data-overdue="1"] {
  color: var(--color-token-text-danger, #d14);
}
[data-codexhost-sidebar-stash-title] {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
[data-codexhost-sidebar-stash-badge] {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--color-token-bg-danger-soft, rgba(221, 17, 68, 0.12));
  color: var(--color-token-text-danger, #d14);
  font-size: 11px;
  line-height: 18px;
}
[data-codexhost-sidebar-stash-due] {
  flex: 0 0 auto;
  color: var(--color-token-text-secondary, #8b8b8b);
  font-size: 11px;
}
[data-codexhost-sidebar-stash-menu] {
  position: fixed;
  z-index: 10000;
  min-width: 180px;
  padding: 4px;
  border: 1px solid var(--color-token-border, rgba(127, 127, 127, 0.25));
  border-radius: 10px;
  background: var(--color-token-bg-elevated, #1e1e1e);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  color: inherit;
}
[data-codexhost-sidebar-stash-menu] button {
  display: block;
  width: 100%;
  margin: 0;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
[data-codexhost-sidebar-stash-menu] button:hover {
  background: var(--color-token-bg-hover, rgba(127, 127, 127, 0.12));
}
[data-codexhost-sidebar-stash-popover] {
  position: fixed;
  z-index: 10001;
  min-width: 220px;
  padding: 10px;
  border: 1px solid var(--color-token-border, rgba(127, 127, 127, 0.25));
  border-radius: 12px;
  background: var(--color-token-bg-elevated, #1e1e1e);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.3);
  color: inherit;
}
[data-codexhost-sidebar-stash-popover] h2 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}
[data-codexhost-sidebar-stash-popover] .codexhost-stash-presets {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}
[data-codexhost-sidebar-stash-popover] .codexhost-stash-presets button,
[data-codexhost-sidebar-stash-popover] .codexhost-stash-actions button {
  display: block;
  width: 100%;
  margin: 0;
  padding: 7px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
[data-codexhost-sidebar-stash-popover] .codexhost-stash-presets button:hover,
[data-codexhost-sidebar-stash-popover] .codexhost-stash-actions button:hover {
  background: var(--color-token-bg-hover, rgba(127, 127, 127, 0.12));
}
[data-codexhost-sidebar-stash-popover] .codexhost-stash-custom {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
[data-codexhost-sidebar-stash-popover] .codexhost-stash-custom input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--color-token-border, rgba(127, 127, 127, 0.25));
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
}
[data-codexhost-sidebar-stash-popover] .codexhost-stash-actions {
  display: flex;
  gap: 6px;
}
[data-codexhost-sidebar-stash-popover] .codexhost-stash-actions button {
  flex: 1 1 0;
  text-align: center;
}
`.trim();

export function ensureStyles(doc: Document = document): () => void {
  const head = doc.head;
  if (
    !head ||
    typeof head.querySelector !== "function" ||
    typeof doc.createElement !== "function"
  ) {
    return () => {};
  }
  if (head.querySelector(`[${STYLE_ATTR}]`)) {
    return () => {
      head.querySelector(`[${STYLE_ATTR}]`)?.remove();
    };
  }
  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTR, "1");
  style.textContent = STYLES;
  head.appendChild(style);
  return () => {
    style.remove();
  };
}
