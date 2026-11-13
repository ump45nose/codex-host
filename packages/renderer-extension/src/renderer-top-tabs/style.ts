export const TOP_TABS_STYLE_ID = "codexhost-top-tabs-styles";

/** Uses Codex Desktop's own tokens and inherited fonts so the strip reads as part of the native page. */
export function buildTopTabsCss(): string {
  return `
[data-codexhost-top-tabs] {
  position: relative;
  flex-shrink: 0;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 2px;
  min-width: 0;
  padding: 6px 12px 2px;
  font: inherit;
  color: var(--color-token-text-secondary);
  -webkit-app-region: no-drag;
}
[data-codexhost-top-tabs][hidden] { display: none; }
.codexhost-session-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--text-xs, 13px);
  cursor: pointer;
}
.codexhost-session-tab:hover { background: var(--color-token-list-hover-background); color: var(--color-token-foreground); }
.codexhost-session-tab:focus-visible { outline: 2px solid var(--color-token-focus-border); outline-offset: -2px; }
.codexhost-session-tab[aria-selected="true"] {
  background: var(--color-token-interactive-bg-secondary-selected);
  color: var(--color-token-foreground);
}
.codexhost-session-tab[data-codexhost-top-tabs-more] { justify-content: center; font-variant-numeric: tabular-nums; }
.codexhost-session-tab[data-codexhost-top-tabs-more][aria-expanded="true"] { background: var(--color-token-list-hover-background); color: var(--color-token-foreground); }
.codexhost-session-tab-icon { display: inline-flex; flex-shrink: 0; }
.codexhost-session-tab-icon :is(svg, img) { width: 14px; height: 14px; display: block; }
.codexhost-session-tab-title { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: start; }
.codexhost-session-tab-host { flex-shrink: 0; width: 12px; height: 12px; display: block; }
.codexhost-session-tab-indicator { flex-shrink: 0; }
[data-codexhost-top-tabs-menu] {
  position: absolute;
  top: calc(100% + 2px);
  right: 12px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  width: min(320px, calc(100% - 24px));
  max-height: 360px;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid var(--color-token-menu-border, var(--color-token-dropdown-border));
  border-radius: 12px;
  background: var(--color-token-menu-background, var(--color-token-dropdown-background));
  color: var(--color-token-menu-foreground, var(--color-token-foreground));
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.16));
}
[data-codexhost-top-tabs-menu] .codexhost-session-tab { flex-shrink: 0; width: 100%; }
[data-codexhost-top-tabs-menu] .codexhost-session-tab:hover {
  background: var(--color-token-menu-selection-background, var(--color-token-list-hover-background));
  color: var(--color-token-menu-selection-foreground, var(--color-token-foreground));
}
`.trim();
}

export function ensureTopTabsStyles(document: Document): void {
  if (document.getElementById(TOP_TABS_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = TOP_TABS_STYLE_ID;
  style.textContent = buildTopTabsCss();
  (document.head ?? document.documentElement).appendChild(style);
}
