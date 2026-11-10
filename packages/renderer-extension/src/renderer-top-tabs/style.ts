export const TOP_TABS_STYLE_ID = "codexhost-top-tabs-styles";

export function buildTopTabsCss(): string {
  return `
/* CodexHost Top Capsule Tabs embedded in main 38px toolbar */
[data-codexhost-top-tabs] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: min(680px, 60vw);
  height: 28px;
  margin-inline: 6px;
  padding: 1px;
  border-radius: 8px;
  -webkit-app-region: no-drag;
  user-select: none;
  flex: 0 1 auto;
  position: relative;
}

[data-codexhost-top-tabs-list] {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  overflow: hidden;
}

[data-codexhost-top-tab] {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  min-width: 78px;
  max-width: 172px;
  padding: 0 7px;
  border-radius: 7px;
  border: 1px solid transparent;
  background-color: color-mix(in oklab, currentColor 5%, transparent);
  color: var(--color-text-secondary, currentColor);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition:
    background-color 140ms cubic-bezier(0.22, 1, 0.36, 1),
    border-color 140ms cubic-bezier(0.22, 1, 0.36, 1),
    color 140ms ease,
    box-shadow 140ms ease;
}

[data-codexhost-top-tab]:hover {
  background-color: color-mix(in oklab, currentColor 9%, transparent);
  color: var(--color-text-primary, currentColor);
}

[data-codexhost-top-tab][data-active="true"] {
  background-color: color-mix(in oklab, var(--color-surface, #252526) 92%, currentColor 8%);
  border-color: color-mix(in oklab, currentColor 18%, transparent);
  color: var(--color-text-primary, currentColor);
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.14);
}

[data-codexhost-top-tab-icon] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

[data-codexhost-top-tab-icon] svg,
[data-codexhost-top-tab-icon] img {
  width: 13px;
  height: 13px;
  display: block;
}

[data-codexhost-top-tab-title] {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: start;
}

[data-codexhost-top-tab-host] {
  font-size: 10px;
  opacity: 0.68;
  margin-inline-end: 2px;
}

/* Status indicator dot */
[data-codexhost-top-tab-status] {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  flex-shrink: 0;
  display: none;
}

[data-codexhost-top-tab-status][data-status="waiting"] {
  display: inline-block;
  background-color: #f59e0b;
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.22);
}

[data-codexhost-top-tab-status][data-status="failed"] {
  display: inline-block;
  background-color: #ef4444;
}

[data-codexhost-top-tab-status][data-status="running"] {
  display: inline-block;
  background-color: #3b82f6;
  animation: codexhost-top-tab-pulse 1.5s ease-in-out infinite;
}

[data-codexhost-top-tab-status][data-status="unread"] {
  display: inline-block;
  background-color: #10b981;
}

@keyframes codexhost-top-tab-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.88); }
}

/* Child threads count badge inside parent capsule */
[data-codexhost-top-tab-children] {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 17px;
  padding: 0 4px;
  border-radius: 4px;
  border: none;
  background-color: color-mix(in oklab, currentColor 11%, transparent);
  color: inherit;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

[data-codexhost-top-tab-children]:hover {
  background-color: color-mix(in oklab, currentColor 18%, transparent);
}

/* Close button on capsule */
[data-codexhost-top-tab-close] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  opacity: 0;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 100ms ease, background-color 100ms ease;
}

[data-codexhost-top-tab]:hover [data-codexhost-top-tab-close],
[data-codexhost-top-tab][data-active="true"] [data-codexhost-top-tab-close] {
  opacity: 0.62;
}

[data-codexhost-top-tab-close]:hover {
  opacity: 1 !important;
  background-color: color-mix(in oklab, currentColor 15%, transparent);
}

/* Overflow "More · N" button */
[data-codexhost-top-tabs-more] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid transparent;
  background-color: color-mix(in oklab, currentColor 6%, transparent);
  color: var(--color-text-secondary, currentColor);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

[data-codexhost-top-tabs-more]:hover,
[data-codexhost-top-tabs-more][aria-expanded="true"] {
  background-color: color-mix(in oklab, currentColor 12%, transparent);
  color: var(--color-text-primary, currentColor);
}

/* Dropdown menu for child threads & overflow tabs */
[data-codexhost-top-tabs-menu] {
  position: fixed;
  z-index: 80;
  min-width: 220px;
  max-width: 320px;
  max-height: 340px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 10px;
  background-color: color-mix(in oklab, var(--color-surface, #1e1e1e) 96%, transparent);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  box-shadow:
    inset 0 0 0 1px rgba(127, 127, 127, 0.24),
    0 12px 28px rgba(0, 0, 0, 0.32);
  color: var(--color-text-primary, currentColor);
  font-size: 12px;
  -webkit-app-region: no-drag;
}

[data-codexhost-top-tabs-menu-item] {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  text-align: start;
  cursor: pointer;
}

[data-codexhost-top-tabs-menu-item]:hover {
  background-color: color-mix(in oklab, currentColor 10%, transparent);
}

[data-codexhost-top-tabs-menu-item][data-active="true"] {
  background-color: color-mix(in oklab, currentColor 14%, transparent);
  font-weight: 500;
}

[data-codexhost-top-tabs-menu-section] {
  padding: 4px 8px 2px;
  font-size: 10.5px;
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 0.03em;
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
