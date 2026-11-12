export const SIDEBAR_OVERLAY_STYLE_ID = "codexhost-sidebar-overlay-styles";

export function buildSidebarOverlayCss(): string {
  return "";
}

export function ensureSidebarOverlayStyles(document: Document): void {
  document.getElementById(SIDEBAR_OVERLAY_STYLE_ID)?.remove();
}
