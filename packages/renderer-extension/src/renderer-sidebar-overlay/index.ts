import type { RendererSettingsLocale } from "../settings/localization.js";
import {
  DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT,
  readSidebarAutoCollapsePreference,
  readSidebarOverlayBreakpoint,
  subscribeSidebarAutoCollapsePreference,
  writeSidebarAutoCollapsePreference,
} from "./preference.js";
import { ensureSidebarOverlayStyles } from "./style.js";

export const SIDEBAR_OVERLAY_HTML_ATTRIBUTE = "data-codexhost-sidebar-overlay";
export const SIDEBAR_OVERLAY_OPEN_HTML_ATTRIBUTE = "data-codexhost-sidebar-overlay-open";
export const SIDEBAR_PIN_BUTTON_ATTRIBUTE = "data-codexhost-sidebar-pin-button";

export interface InstallRendererSidebarOverlayOptions {
  readonly document?: Document;
  readonly window?: Window;
  readonly getLocale?: () => RendererSettingsLocale;
}

export interface RendererSidebarOverlayHandle {
  readonly isAutoCollapseEnabled: () => boolean;
  readonly setAutoCollapseEnabled: (enabled: boolean) => void;
  readonly isNarrowViewport: () => boolean;
  readonly refresh: () => void;
  readonly dispose: () => void;
}

export function installRendererSidebarOverlay(
  options: InstallRendererSidebarOverlayOptions = {},
): RendererSidebarOverlayHandle {
  const doc = options.document ?? document;
  const win = options.window ?? doc.defaultView ?? window;

  ensureSidebarOverlayStyles(doc);
  doc.documentElement?.removeAttribute(SIDEBAR_OVERLAY_HTML_ATTRIBUTE);
  doc.documentElement?.removeAttribute(SIDEBAR_OVERLAY_OPEN_HTML_ATTRIBUTE);
  for (const btn of doc.querySelectorAll(`[${SIDEBAR_PIN_BUTTON_ATTRIBUTE}]`)) {
    btn.remove();
  }

  let disposed = false;
  let wasNarrow: boolean | null = null;
  let wasEnabled: boolean | null = null;
  let pendingCollapseOnNarrowEntry = false;

  const readViewportWidth = (): number => {
    if (typeof win.innerWidth === "number" && win.innerWidth > 0) return win.innerWidth;
    const rectWidth =
      doc.querySelector<HTMLElement>("[data-app-shell-frame]")?.getBoundingClientRect?.().width ??
      0;
    return rectWidth > 0 ? rectWidth : DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT;
  };

  const tryCollapseNativeSidebarOnce = (): void => {
    if (disposed || !pendingCollapseOnNarrowEntry) return;
    const frame = doc.querySelector<HTMLElement>("[data-app-shell-frame]");
    if (!frame) return;
    const sidebarOpenAttr = frame.getAttribute("data-app-shell-sidebar-open");
    if (sidebarOpenAttr === "false") {
      pendingCollapseOnNarrowEntry = false;
      return;
    }
    if (sidebarOpenAttr !== "true") return;
    const trigger = doc.querySelector<HTMLElement>("[data-app-shell-sidebar-trigger]");
    if (!trigger) return;
    pendingCollapseOnNarrowEntry = false;
    trigger.click();
  };

  const evaluateModeAndViewport = (): void => {
    if (disposed) return;
    const enabled = readSidebarAutoCollapsePreference(win);
    const breakpoint = readSidebarOverlayBreakpoint(win);
    const viewportWidth = readViewportWidth();
    const isNarrow = viewportWidth > 0 && viewportWidth < breakpoint;

    const enteredNarrow = isNarrow && (wasNarrow === null || !wasNarrow);
    const enabledInNarrow = isNarrow && enabled && wasEnabled === false;

    wasNarrow = isNarrow;
    wasEnabled = enabled;

    if (!enabled || !isNarrow) {
      pendingCollapseOnNarrowEntry = false;
      return;
    }
    if (enteredNarrow || enabledInNarrow) {
      pendingCollapseOnNarrowEntry = true;
    }
    if (pendingCollapseOnNarrowEntry) {
      tryCollapseNativeSidebarOnce();
    }
  };

  const unsubscribePreference = subscribeSidebarAutoCollapsePreference(
    win,
    evaluateModeAndViewport,
  );
  win.addEventListener("resize", evaluateModeAndViewport);

  const mutationObserver =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          if (!disposed && pendingCollapseOnNarrowEntry) tryCollapseNativeSidebarOnce();
        })
      : null;
  if (mutationObserver && doc.documentElement) {
    mutationObserver.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-app-shell-sidebar-open"],
    });
  }

  evaluateModeAndViewport();

  return {
    isAutoCollapseEnabled: () => readSidebarAutoCollapsePreference(win),
    setAutoCollapseEnabled: (enabled: boolean) => {
      writeSidebarAutoCollapsePreference(enabled, win, win);
      evaluateModeAndViewport();
    },
    isNarrowViewport: () => Boolean(wasNarrow),
    refresh: evaluateModeAndViewport,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      pendingCollapseOnNarrowEntry = false;
      unsubscribePreference();
      mutationObserver?.disconnect();
      win.removeEventListener("resize", evaluateModeAndViewport);
    },
  };
}
