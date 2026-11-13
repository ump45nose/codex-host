export const TOP_TABS_STYLE_ID = "codexhost-top-tabs-styles";

/** Uses Codex Desktop's own tokens and inherited fonts so the strip reads as part of the native page. */
export function buildTopTabsCss(): string {
  return `
[data-codexhost-top-tabs] {
  container-type: inline-size;
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  padding: 6px 12px 2px;
  overflow-x: auto;
  scrollbar-width: none;
  font: inherit;
  color: var(--color-token-text-secondary);
  -webkit-app-region: no-drag;
}
[data-codexhost-top-tabs][hidden] { display: none; }
.codexhost-session-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 180px;
  min-width: 168px;
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
  flex-basis: 220px;
  background: var(--color-token-interactive-bg-secondary-selected);
  color: var(--color-token-foreground);
}
.codexhost-session-tab-icon { display: inline-flex; flex-shrink: 0; }
.codexhost-session-tab-icon :is(svg, img) { width: 14px; height: 14px; display: block; }
.codexhost-session-tab-title { flex: 1 1 0; min-width: 3em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: start; }
.codexhost-session-tab-host { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-token-text-tertiary); }
.codexhost-session-tab-indicator { flex-shrink: 0; }
@container (max-width: 720px) {
  .codexhost-session-tab:not([aria-selected="true"]) { flex: 0 0 auto; min-width: 0; }
  .codexhost-session-tab:not([aria-selected="true"]) :is(.codexhost-session-tab-title, .codexhost-session-tab-host) { display: none; }
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
