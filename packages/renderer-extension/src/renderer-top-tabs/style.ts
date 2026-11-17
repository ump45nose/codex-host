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
.codexhost-session-tab-status {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.codexhost-session-tab-status[data-status="running"] { background: #3b82f6; animation: codexhost-session-tab-pulse 1.4s ease-in-out infinite; }
.codexhost-session-tab-status[data-status="waiting"] { background: #f59e0b; }
.codexhost-session-tab-status[data-status="unread"] { background: #22c55e; }
.codexhost-session-tab-status[data-status="failed"] { background: #ef4444; }
@keyframes codexhost-session-tab-pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  .codexhost-session-tab-status[data-status="running"] { animation: none; }
}
.codexhost-session-tab-stash {
  display: none;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-inline-end: -4px;
  border-radius: 5px;
  color: var(--color-token-text-secondary);
}
.codexhost-session-tab-stash svg { width: 13px; height: 13px; display: block; }
.codexhost-session-tab:is(:hover, :focus-within) .codexhost-session-tab-stash { display: inline-flex; }
.codexhost-session-tab:is(:hover, :focus-within):has(> .codexhost-session-tab-stash) > .codexhost-session-tab-status { display: none; }
.codexhost-session-tab-stash:hover { background: var(--color-token-interactive-bg-secondary-selected); color: var(--color-token-foreground); }
[data-codexhost-top-tab-context-menu] {
  position: fixed;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  min-width: 168px;
  padding: 4px;
  border: 1px solid var(--color-token-menu-border, var(--color-token-dropdown-border));
  border-radius: 10px;
  background: var(--color-token-menu-background, var(--color-token-dropdown-background));
  color: var(--color-token-menu-foreground, var(--color-token-foreground));
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.16));
  font-size: var(--text-xs, 13px);
}
[data-codexhost-top-tab-context-menu] button {
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
[data-codexhost-top-tab-context-menu] button:hover {
  background: var(--color-token-menu-selection-background, var(--color-token-list-hover-background));
  color: var(--color-token-menu-selection-foreground, var(--color-token-foreground));
}
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
