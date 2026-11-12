export {
  installRendererSidebarOverlay,
  SIDEBAR_OVERLAY_HTML_ATTRIBUTE,
  SIDEBAR_OVERLAY_OPEN_HTML_ATTRIBUTE,
  SIDEBAR_PIN_BUTTON_ATTRIBUTE,
  type InstallRendererSidebarOverlayOptions,
  type RendererSidebarOverlayHandle,
} from "./renderer-sidebar-overlay/index.js";
export {
  DEFAULT_SIDEBAR_AUTO_COLLAPSE,
  DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT,
  SIDEBAR_AUTO_COLLAPSE_PREFERENCE_CHANGE_EVENT,
  SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY,
  SIDEBAR_OVERLAY_BREAKPOINT_STORAGE_KEY,
  SIDEBAR_OVERLAY_MODE_STORAGE_KEY,
  SIDEBAR_OVERLAY_PREFERENCE_CHANGE_EVENT,
  parseSidebarAutoCollapsePreference,
  readSidebarAutoCollapsePreference,
  readSidebarOverlayBreakpoint,
  setSidebarAutoCollapsePreference,
  subscribeSidebarAutoCollapsePreference,
  subscribeSidebarOverlayPreference,
  writeSidebarAutoCollapsePreference,
} from "./renderer-sidebar-overlay/preference.js";
export {
  SIDEBAR_OVERLAY_STYLE_ID,
  buildSidebarOverlayCss,
  ensureSidebarOverlayStyles,
} from "./renderer-sidebar-overlay/style.js";
