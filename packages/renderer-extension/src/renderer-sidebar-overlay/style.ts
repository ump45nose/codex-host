export const SIDEBAR_OVERLAY_STYLE_ID = "codexhost-sidebar-overlay-styles";

export function buildSidebarOverlayCss(): string {
  return `
/* CodexHost Sidebar Overlay Floating Drawer (Vertical Screen Mode) */
html[data-codexhost-sidebar-overlay="true"] [data-app-shell-frame] {
  --codexhost-sidebar-overlay-width: var(--app-shell-left-panel-target-width, 268px);
  --app-shell-left-panel-width: var(--app-shell-navigation-rail-width, 0px) !important;
  --app-shell-animated-left-panel-width: var(--app-shell-navigation-rail-width, 0px) !important;
}

html[data-codexhost-sidebar-overlay="true"] aside.app-shell-left-panel {
  width: var(--app-shell-navigation-rail-width, 0px) !important;
  min-width: var(--app-shell-navigation-rail-width, 0px) !important;
  max-width: var(--app-shell-navigation-rail-width, 0px) !important;
  flex: 0 0 var(--app-shell-navigation-rail-width, 0px) !important;
  overflow: visible !important;
  z-index: 45 !important;
  border-inline-end: none !important;
}

html[data-codexhost-sidebar-overlay="true"] aside.app-shell-left-panel > #app-shell-sidebar {
  overflow: visible !important;
}

/* Disable Codex native 0..4px screen-edge blind hover popover when our overlay controller is active */
html[data-codexhost-sidebar-overlay="true"] aside[data-testid="app-shell-floating-left-panel"] {
  display: none !important;
  pointer-events: none !important;
}

/* Primary floating drawer target when navigation rail wrapper exists */
html[data-codexhost-sidebar-overlay="true"] aside.app-shell-left-panel [data-sidebar-navigation-root],
html[data-codexhost-sidebar-overlay="true"] aside.app-shell-left-panel:not(:has([data-sidebar-navigation-root])) > #app-shell-sidebar {
  position: fixed !important;
  inset-block-start: calc(var(--toolbar-height, 38px) + 6px) !important;
  inset-block-end: 8px !important;
  inset-inline-start: calc(var(--app-shell-navigation-rail-width, 0px) + 8px) !important;
  width: min(var(--codexhost-sidebar-overlay-width, 268px), calc(100vw - var(--app-shell-navigation-rail-width, 0px) - 24px)) !important;
  min-width: 244px !important;
  max-width: 380px !important;
  height: auto !important;
  z-index: 60 !important;
  border-radius: var(--app-shell-sidebar-popover-radius, 12px) !important;
  background-color: color-mix(in oklab, var(--color-surface, #1e1e1e) 94%, transparent) !important;
  -webkit-backdrop-filter: blur(14px) saturate(135%) !important;
  backdrop-filter: blur(14px) saturate(135%) !important;
  box-shadow:
    inset 0 0 0 var(--hairline, 1px) var(--app-shell-sidebar-popover-border, rgba(127, 127, 127, 0.24)),
    var(--shadow-card, 0 14px 36px rgba(0, 0, 0, 0.34)) !important;
  overflow: hidden !important;
  transform: translate3d(calc(-100% - 16px), 0, 0);
  opacity: 0;
  pointer-events: none;
  transition:
    transform 190ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 150ms ease;
  will-change: transform, opacity;
}

html[data-codexhost-sidebar-overlay="true"][data-codexhost-sidebar-overlay-open="true"] aside.app-shell-left-panel [data-sidebar-navigation-root],
html[data-codexhost-sidebar-overlay="true"][data-codexhost-sidebar-overlay-open="true"] aside.app-shell-left-panel:not(:has([data-sidebar-navigation-root])) > #app-shell-sidebar {
  transform: translate3d(0, 0, 0);
  opacity: 1;
  pointer-events: auto;
}

/* Keep the navigation rail interactive and clear of the floating card */
html[data-codexhost-sidebar-overlay="true"] nav[data-app-navigation-rail] {
  position: relative;
  z-index: 61;
}

/* Pin / Unpin toggle button in sidebar header and toolbar */
[data-codexhost-sidebar-pin-button] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary, currentColor);
  opacity: 0.72;
  cursor: pointer;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}

[data-codexhost-sidebar-pin-button]:hover {
  opacity: 1;
  color: var(--color-text-primary, currentColor);
  background-color: color-mix(in oklab, currentColor 10%, transparent);
}

[data-codexhost-sidebar-pin-button][data-pinned="true"] {
  opacity: 0.92;
  color: var(--color-accent, var(--color-text-primary, currentColor));
}

[data-codexhost-sidebar-pin-button] svg {
  width: 15px;
  height: 15px;
  display: block;
}

/* Subtle dwell cue on sidebar trigger while hovering before expansion */
[data-app-shell-sidebar-trigger][data-codexhost-dwell-pending="true"] {
  background-color: color-mix(in oklab, currentColor 12%, transparent);
}
`.trim();
}

export function ensureSidebarOverlayStyles(document: Document): void {
  const existing = document.getElementById(SIDEBAR_OVERLAY_STYLE_ID);
  if (existing) {
    return;
  }
  const style = document.createElement("style");
  style.id = SIDEBAR_OVERLAY_STYLE_ID;
  style.textContent = buildSidebarOverlayCss();
  (document.head ?? document.documentElement).appendChild(style);
}
