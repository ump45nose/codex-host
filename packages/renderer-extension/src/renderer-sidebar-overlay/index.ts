import type { RendererSettingsLocale } from "../settings/localization.js";
import {
  DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT,
  DEFAULT_SIDEBAR_OVERLAY_LEAVE_MS,
  readSidebarOverlayBreakpoint,
  readSidebarOverlayDwellMs,
  readSidebarOverlayMode,
  resolveSidebarOverlayEffective,
  subscribeSidebarOverlayPreference,
  writeSidebarOverlayMode,
  type SidebarOverlayMode,
} from "./preference.js";
import { ensureSidebarOverlayStyles } from "./style.js";

export const SIDEBAR_OVERLAY_HTML_ATTRIBUTE = "data-codexhost-sidebar-overlay";
export const SIDEBAR_OVERLAY_OPEN_HTML_ATTRIBUTE = "data-codexhost-sidebar-overlay-open";
export const SIDEBAR_PIN_BUTTON_ATTRIBUTE = "data-codexhost-sidebar-pin-button";

export interface InstallRendererSidebarOverlayOptions {
  readonly document?: Document;
  readonly window?: Window;
  readonly getLocale?: () => RendererSettingsLocale;
  readonly dwellMs?: number;
  readonly leaveMs?: number;
}

export interface RendererSidebarOverlayHandle {
  readonly isOverlayEffective: () => boolean;
  readonly isDrawerOpen: () => boolean;
  readonly setDrawerOpen: (open: boolean) => void;
  readonly getMode: () => SidebarOverlayMode;
  readonly setMode: (mode: SidebarOverlayMode) => void;
  readonly refresh: () => void;
  readonly dispose: () => void;
}

const PIN_ICON_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5L13.5 6.5L12 8L9.5 6.5L6.5 9.5L8 12L6.5 13.5L3.5 10.5L1.5 14.5L5.5 12.5L2.5 9.5L4 8L6.5 9.5L9.5 6.5L8 4L9.5 2.5Z"/></svg>`;
const OVERLAY_ICON_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5V13.5"/><path d="M8.75 6.5L10.75 8L8.75 9.5"/></svg>`;

function asElement(value: unknown): HTMLElement | null {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Element).closest === "function"
  ) {
    return value as HTMLElement;
  }
  return null;
}

function isElementInsideFloatingDrawer(target: Element | null): boolean {
  if (!target) return false;
  return Boolean(
    target.closest(
      '[data-sidebar-navigation-root], #app-shell-sidebar, nav[data-app-navigation-rail], [data-app-shell-sidebar-trigger], [data-codexhost-sidebar-stash-menu], [data-codexhost-sidebar-stash-popover], [role="menu"], [data-radix-popper-content-wrapper]',
    ),
  );
}

function hasActiveSidebarInteractionLock(doc: Document, dragging: boolean): boolean {
  if (dragging) return true;
  const active = asElement(doc.activeElement);
  if (
    active &&
    active.closest("[data-sidebar-navigation-root], #app-shell-sidebar") &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable ||
      active.getAttribute("role") === "searchbox" ||
      active.getAttribute("role") === "combobox")
  ) {
    return true;
  }
  if (
    doc.querySelector(
      '[data-codexhost-sidebar-stash-menu], [data-codexhost-sidebar-stash-popover], [data-radix-popper-content-wrapper] [role="menu"], [data-sidebar-navigation-root] [ aria-expanded="true"][aria-haspopup="menu"]',
    )
  ) {
    return true;
  }
  return false;
}

export function installRendererSidebarOverlay(
  options: InstallRendererSidebarOverlayOptions = {},
): RendererSidebarOverlayHandle {
  const doc = options.document ?? document;
  const win = options.window ?? doc.defaultView ?? window;
  const getLocale = options.getLocale ?? ((): RendererSettingsLocale => "zh-CN");
  const leaveMs = options.leaveMs ?? DEFAULT_SIDEBAR_OVERLAY_LEAVE_MS;

  ensureSidebarOverlayStyles(doc);

  let disposed = false;
  let overlayEffective = false;
  let drawerOpen = false;
  let draggingInSidebar = false;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;
  let dwellTarget: HTMLElement | null = null;

  const clearDwellTimer = (): void => {
    if (dwellTimer !== null) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    }
    if (dwellTarget) {
      dwellTarget.removeAttribute("data-codexhost-dwell-pending");
      dwellTarget = null;
    }
  };

  const clearLeaveTimer = (): void => {
    if (leaveTimer !== null) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  };

  const readViewportWidth = (): number => {
    const frame = doc.querySelector<HTMLElement>("[data-app-shell-frame]");
    const rectWidth = frame?.getBoundingClientRect().width ?? 0;
    if (rectWidth > 0) return rectWidth;
    return win.innerWidth || DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT;
  };

  const ensureNativeSidebarMounted = (): void => {
    if (!overlayEffective) return;
    const frame = doc.querySelector<HTMLElement>("[data-app-shell-frame]");
    if (!frame) return;
    const isOpenAttr = frame.getAttribute("data-app-shell-sidebar-open");
    const leftPanel = doc.querySelector<HTMLElement>("aside.app-shell-left-panel");
    if (isOpenAttr === "false" && !leftPanel) {
      const trigger = doc.querySelector<HTMLButtonElement>("[data-app-shell-sidebar-trigger]");
      if (trigger) {
        // Trigger native React state once so aside.app-shell-left-panel stays mounted in DOM
        // and native 0..4px edge hover is disabled while our CSS collapses its flex footprint.
        trigger.click();
      }
    }
  };

  const applyHtmlAttributes = (): void => {
    const html = doc.documentElement;
    if (!html) return;
    if (overlayEffective) {
      html.setAttribute(SIDEBAR_OVERLAY_HTML_ATTRIBUTE, "true");
      html.setAttribute(SIDEBAR_OVERLAY_OPEN_HTML_ATTRIBUTE, drawerOpen ? "true" : "false");
    } else {
      html.removeAttribute(SIDEBAR_OVERLAY_HTML_ATTRIBUTE);
      html.removeAttribute(SIDEBAR_OVERLAY_OPEN_HTML_ATTRIBUTE);
    }
  };

  const setDrawerOpen = (nextOpen: boolean): void => {
    if (disposed) return;
    clearDwellTimer();
    clearLeaveTimer();
    if (!overlayEffective) {
      drawerOpen = false;
      applyHtmlAttributes();
      return;
    }
    drawerOpen = nextOpen;
    applyHtmlAttributes();
    syncPinButtonState();
  };

  const pinButtonLabels = (): { title: string; ariaLabel: string } => {
    const locale = getLocale();
    if (overlayEffective) {
      return locale === "zh-CN"
        ? {
            title: "固定展开侧边栏（切换为常驻布局）",
            ariaLabel: "固定展开侧边栏",
          }
        : {
            title: "Pin sidebar open (docked mode)",
            ariaLabel: "Pin sidebar open",
          };
    }
    return locale === "zh-CN"
      ? {
          title: "切换为悬浮抽屉（不挤压正文宽度）",
          ariaLabel: "切换为悬浮抽屉",
        }
      : {
          title: "Switch sidebar to floating overlay drawer",
          ariaLabel: "Switch sidebar to floating overlay drawer",
        };
  };

  const syncPinButtonState = (): void => {
    const buttons = doc.querySelectorAll<HTMLButtonElement>(`[${SIDEBAR_PIN_BUTTON_ATTRIBUTE}]`);
    const { title, ariaLabel } = pinButtonLabels();
    const pinned = !overlayEffective;
    const pinnedValue = pinned ? "true" : "false";
    for (const button of buttons) {
      // Preserve the icon so our subtree observer does not keep triggering itself.
      if (button.getAttribute("data-pinned") !== pinnedValue) {
        button.setAttribute("data-pinned", pinnedValue);
        button.innerHTML = pinned ? PIN_ICON_SVG : OVERLAY_ICON_SVG;
      }
      if (button.getAttribute("aria-pressed") !== pinnedValue) {
        button.setAttribute("aria-pressed", pinnedValue);
      }
      if (button.title !== title) button.title = title;
      if (button.getAttribute("aria-label") !== ariaLabel) {
        button.setAttribute("aria-label", ariaLabel);
      }
    }
  };

  const ensurePinButtonMounted = (): void => {
    const sidebarRoot =
      doc.querySelector<HTMLElement>("[data-sidebar-navigation-root]") ??
      doc.querySelector<HTMLElement>("#app-shell-sidebar");
    if (!sidebarRoot) return;
    const headerActions =
      sidebarRoot.querySelector<HTMLElement>(".gap-toolbar-action") ??
      sidebarRoot.querySelector<HTMLElement>(
        "[data-slate-sidebar-content] .ms-auto.flex.items-center",
      );
    if (!headerActions) return;

    let button = headerActions.querySelector<HTMLButtonElement>(
      `[${SIDEBAR_PIN_BUTTON_ATTRIBUTE}]`,
    );
    if (!button) {
      button = doc.createElement("button");
      button.type = "button";
      button.setAttribute(SIDEBAR_PIN_BUTTON_ATTRIBUTE, "true");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (overlayEffective) {
          writeSidebarOverlayMode("docked", win, win);
        } else {
          writeSidebarOverlayMode("overlay", win, win);
          setDrawerOpen(true);
        }
      });
      headerActions.prepend(button);
    }
    syncPinButtonState();
  };

  const evaluateModeAndViewport = (): void => {
    if (disposed) return;
    const mode = readSidebarOverlayMode(win);
    const breakpoint = readSidebarOverlayBreakpoint(win);
    const viewportWidth = readViewportWidth();
    const nextEffective = resolveSidebarOverlayEffective({
      mode,
      viewportWidth,
      breakpoint,
    });
    const changed = nextEffective !== overlayEffective;
    overlayEffective = nextEffective;
    if (!overlayEffective) {
      drawerOpen = false;
      clearDwellTimer();
      clearLeaveTimer();
    } else if (changed) {
      drawerOpen = false;
      ensureNativeSidebarMounted();
    }
    applyHtmlAttributes();
    ensurePinButtonMounted();
  };

  // Click interception on [data-app-shell-sidebar-trigger]: in Overlay mode, toggle floating drawer
  // instead of letting React unmount aside.app-shell-left-panel.
  const handleDocumentClickCapture = (event: MouseEvent): void => {
    if (!overlayEffective) return;
    const target = asElement(event.target);
    if (!target) return;

    const trigger = target.closest<HTMLElement>("[data-app-shell-sidebar-trigger]");
    if (trigger) {
      const frame = doc.querySelector<HTMLElement>("[data-app-shell-frame]");
      const nativeSidebarOpen = frame?.getAttribute("data-app-shell-sidebar-open") !== "false";
      if (nativeSidebarOpen) {
        event.preventDefault();
        event.stopPropagation();
        setDrawerOpen(!drawerOpen);
        return;
      }
      // If native sidebar was somehow collapsed, let native click open it and open our overlay drawer
      setDrawerOpen(true);
      return;
    }

    // If user clicks a thread row inside the floating drawer, close drawer after navigation unless locked
    if (drawerOpen && target.closest("[data-app-action-sidebar-thread-row]")) {
      if (!target.closest('button, [role="button"], [data-codexhost-sidebar-thread-toggle]')) {
        clearLeaveTimer();
        leaveTimer = setTimeout(() => {
          leaveTimer = null;
          if (!hasActiveSidebarInteractionLock(doc, draggingInSidebar)) {
            setDrawerOpen(false);
          }
        }, 140);
      }
      return;
    }

    // Click outside floating drawer closes it when not locked
    if (
      drawerOpen &&
      !isElementInsideFloatingDrawer(target) &&
      !hasActiveSidebarInteractionLock(doc, draggingInSidebar)
    ) {
      setDrawerOpen(false);
    }
  };

  // Hover dwell on navigation rail or sidebar trigger (not on 0..4px screen edge!)
  const handlePointerOver = (event: PointerEvent): void => {
    if (!overlayEffective) return;
    const target = asElement(event.target);
    if (!target) return;

    if (isElementInsideFloatingDrawer(target)) {
      clearLeaveTimer();
    }

    if (drawerOpen) return;

    const triggerZone = target.closest<HTMLElement>(
      "nav[data-app-navigation-rail], [data-app-shell-sidebar-trigger]",
    );
    if (!triggerZone) return;

    if (dwellTimer !== null) return;
    const dwellMs = options.dwellMs ?? readSidebarOverlayDwellMs(win);
    dwellTarget = triggerZone;
    triggerZone.setAttribute("data-codexhost-dwell-pending", "true");
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      if (dwellTarget) {
        dwellTarget.removeAttribute("data-codexhost-dwell-pending");
        dwellTarget = null;
      }
      if (!disposed && overlayEffective) {
        setDrawerOpen(true);
      }
    }, dwellMs);
  };

  const handlePointerOut = (event: PointerEvent): void => {
    if (!overlayEffective) return;
    const related = asElement(event.relatedTarget);
    const target = asElement(event.target);

    if (
      dwellTimer !== null &&
      target?.closest("nav[data-app-navigation-rail], [data-app-shell-sidebar-trigger]") &&
      !related?.closest("nav[data-app-navigation-rail], [data-app-shell-sidebar-trigger]")
    ) {
      clearDwellTimer();
    }

    if (!drawerOpen) return;
    if (isElementInsideFloatingDrawer(related)) {
      clearLeaveTimer();
      return;
    }

    if (isElementInsideFloatingDrawer(target) && !isElementInsideFloatingDrawer(related)) {
      clearLeaveTimer();
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        if (
          !disposed &&
          overlayEffective &&
          !hasActiveSidebarInteractionLock(doc, draggingInSidebar)
        ) {
          setDrawerOpen(false);
        }
      }, leaveMs);
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!overlayEffective || !drawerOpen) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      setDrawerOpen(false);
    }
  };

  const handleDragStart = (event: DragEvent): void => {
    const target = asElement(event.target);
    if (target && isElementInsideFloatingDrawer(target)) {
      draggingInSidebar = true;
      clearLeaveTimer();
    }
  };

  const handleDragEnd = (): void => {
    draggingInSidebar = false;
  };

  const unsubscribePreference = subscribeSidebarOverlayPreference(win, () => {
    evaluateModeAndViewport();
  });

  const handleResize = (): void => {
    evaluateModeAndViewport();
  };

  win.addEventListener("resize", handleResize);
  doc.addEventListener("click", handleDocumentClickCapture, true);
  doc.addEventListener("pointerover", handlePointerOver, true);
  doc.addEventListener("pointerout", handlePointerOut, true);
  doc.addEventListener("keydown", handleKeyDown, true);
  doc.addEventListener("dragstart", handleDragStart, true);
  doc.addEventListener("dragend", handleDragEnd, true);
  doc.addEventListener("drop", handleDragEnd, true);

  const mutationObserver =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          if (disposed) return;
          ensurePinButtonMounted();
          if (overlayEffective) {
            ensureNativeSidebarMounted();
          }
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
    isOverlayEffective: () => overlayEffective,
    isDrawerOpen: () => drawerOpen,
    setDrawerOpen,
    getMode: () => readSidebarOverlayMode(win),
    setMode: (mode: SidebarOverlayMode) => {
      writeSidebarOverlayMode(mode, win, win);
      evaluateModeAndViewport();
    },
    refresh: () => {
      evaluateModeAndViewport();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearDwellTimer();
      clearLeaveTimer();
      unsubscribePreference();
      mutationObserver?.disconnect();
      win.removeEventListener("resize", handleResize);
      doc.removeEventListener("click", handleDocumentClickCapture, true);
      doc.removeEventListener("pointerover", handlePointerOver, true);
      doc.removeEventListener("pointerout", handlePointerOut, true);
      doc.removeEventListener("keydown", handleKeyDown, true);
      doc.removeEventListener("dragstart", handleDragStart, true);
      doc.removeEventListener("dragend", handleDragEnd, true);
      doc.removeEventListener("drop", handleDragEnd, true);
      doc.documentElement?.removeAttribute(SIDEBAR_OVERLAY_HTML_ATTRIBUTE);
      doc.documentElement?.removeAttribute(SIDEBAR_OVERLAY_OPEN_HTML_ATTRIBUTE);
      for (const btn of doc.querySelectorAll(`[${SIDEBAR_PIN_BUTTON_ATTRIBUTE}]`)) {
        btn.remove();
      }
    },
  };
}
