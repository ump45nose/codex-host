import { describe, expect, it, vi } from "vitest";

vi.mock("../src/settings/icons.js", () => ({
  createRendererSettingsIcon: (_name: string, _size: number, doc?: Document) => {
    const el = doc ? doc.createElement("svg") : { classList: { add() {} } };
    return el;
  },
  isRendererSettingsIconName: () => true,
}));

import {
  DEFAULT_SIDEBAR_AUTO_COLLAPSE,
  DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT,
  SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY,
  SIDEBAR_OVERLAY_MODE_STORAGE_KEY,
  SIDEBAR_PIN_BUTTON_ATTRIBUTE,
  buildSidebarOverlayCss,
  installRendererSidebarOverlay,
  readSidebarAutoCollapsePreference,
  setSidebarAutoCollapsePreference,
  subscribeSidebarAutoCollapsePreference,
  writeSidebarAutoCollapsePreference,
} from "../src/renderer-sidebar-overlay.js";
import { createAppearanceSettingsPage } from "../src/settings/appearance-page.js";
import { rendererSettingsMessages } from "../src/settings/localization.js";

class FakeElement extends EventTarget {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = {
    add: (...tokens: string[]) => {
      const existing = new Set(this.className.split(/\s+/u).filter(Boolean));
      for (const token of tokens) existing.add(token);
      this.className = [...existing].join(" ");
    },
  };
  parentElement: FakeElement | null = null;
  ownerDocument: FakeDocument;
  tagName: string;
  id = "";
  className = "";
  textContent = "";
  title = "";
  type = "";
  value = "";
  checked = false;
  disabled = false;

  constructor(tagName: string, ownerDocument: FakeDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  getAttribute(name: string): string | null {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    const str = String(value);
    if (name === "id") this.id = str;
    if (name === "class") this.className = str;
    this.attributes.set(name, str);
  }

  removeAttribute(name: string): void {
    if (name === "id") this.id = "";
    if (name === "class") this.className = "";
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        this.appendChild(node);
      }
    }
  }

  prepend(child: FakeElement): void {
    child.parentElement = this;
    this.children.unshift(child);
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    for (const child of this.children) {
      child.parentElement = null;
    }
    this.children.length = 0;
    this.append(...nodes);
  }

  createTHead(): FakeElement {
    return this.appendChild(new FakeElement("thead", this.ownerDocument));
  }

  createTBody(): FakeElement {
    return this.appendChild(new FakeElement("tbody", this.ownerDocument));
  }

  insertRow(): FakeElement {
    return this.appendChild(new FakeElement("tr", this.ownerDocument));
  }

  remove(): void {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx >= 0) this.parentElement.children.splice(idx, 1);
    this.parentElement = null;
  }

  click(): void {
    this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
  }

  matches(selector: string): boolean {
    const trimmed = selector.trim();
    if (trimmed === "[data-app-shell-frame]") {
      return this.hasAttribute("data-app-shell-frame");
    }
    if (trimmed === "[data-app-shell-sidebar-trigger]") {
      return this.hasAttribute("data-app-shell-sidebar-trigger");
    }
    if (trimmed === `[${SIDEBAR_PIN_BUTTON_ATTRIBUTE}]`) {
      return this.hasAttribute(SIDEBAR_PIN_BUTTON_ATTRIBUTE);
    }
    if (trimmed === '[data-testid="app-shell-floating-left-panel"]') {
      return this.getAttribute("data-testid") === "app-shell-floating-left-panel";
    }
    return false;
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return (this.querySelectorAll(selector)[0] as T | undefined) ?? null;
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const results: T[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.matches(selector)) {
          results.push(child as T);
        }
        visit(child);
      }
    };
    visit(this);
    return results;
  }
}

class FakeDocument {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  defaultView: (Window & { innerWidth: number }) | null = null;

  constructor() {
    this.documentElement = new FakeElement("html", this);
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.documentElement.append(this.head, this.body);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  getElementById(id: string): FakeElement | null {
    const find = (node: FakeElement): FakeElement | null => {
      if (node.id === id) return node;
      for (const child of node.children) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    return find(this.documentElement);
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return this.documentElement.querySelector<T>(selector);
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    return this.documentElement.querySelectorAll<T>(selector);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

function createTestEnvironment(initialWidth = 1140) {
  const doc = new FakeDocument();
  const storageMap = new Map<string, string>();
  const storage = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageMap.set(key, String(value));
    },
    removeItem: (key: string) => {
      storageMap.delete(key);
    },
  };

  const win = Object.assign(new EventTarget(), {
    innerWidth: initialWidth,
    document: doc,
    localStorage: storage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  }) as unknown as Window & { innerWidth: number };
  doc.defaultView = win;

  const frame = doc.createElement("div");
  frame.setAttribute("data-app-shell-frame", "");
  frame.setAttribute("data-app-shell-sidebar-open", "true");

  const trigger = doc.createElement("button");
  trigger.setAttribute("data-app-shell-sidebar-trigger", "");
  let triggerClicks = 0;
  trigger.addEventListener("click", () => {
    triggerClicks += 1;
    const isOpen = frame.getAttribute("data-app-shell-sidebar-open") === "true";
    frame.setAttribute("data-app-shell-sidebar-open", isOpen ? "false" : "true");
  });

  const toolbarActions = doc.createElement("div");
  toolbarActions.className = "gap-toolbar-action";

  const sidebar = doc.createElement("div");
  sidebar.id = "app-shell-sidebar";
  sidebar.setAttribute("data-sidebar-navigation-root", "");
  sidebar.append(toolbarActions);

  const floatingPanel = doc.createElement("aside");
  floatingPanel.setAttribute("data-testid", "app-shell-floating-left-panel");

  frame.append(trigger, sidebar, floatingPanel);
  doc.body.append(frame);

  return {
    doc: doc as unknown as Document,
    win,
    frame,
    trigger,
    floatingPanel,
    getTriggerClicks: () => triggerClicks,
    resizeTo: (width: number) => {
      win.innerWidth = width;
      win.dispatchEvent(new Event("resize"));
    },
  };
}

describe("sidebar auto-collapse preference and legacy migration", () => {
  it("defaults to true at 1080px breakpoint and migrates legacy three-state storage values", () => {
    expect(DEFAULT_SIDEBAR_AUTO_COLLAPSE).toBe(true);
    expect(DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT).toBe(1080);

    const { win } = createTestEnvironment();
    expect(readSidebarAutoCollapsePreference(win)).toBe(true);

    win.localStorage.setItem(SIDEBAR_OVERLAY_MODE_STORAGE_KEY, "docked");
    expect(readSidebarAutoCollapsePreference(win)).toBe(false);
    expect(win.localStorage.getItem(SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY)).toBe("false");

    win.localStorage.setItem(SIDEBAR_OVERLAY_MODE_STORAGE_KEY, "auto");
    expect(readSidebarAutoCollapsePreference(win)).toBe(true);
    expect(win.localStorage.getItem(SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY)).toBe("true");

    win.localStorage.setItem(SIDEBAR_OVERLAY_MODE_STORAGE_KEY, "overlay");
    expect(readSidebarAutoCollapsePreference(win)).toBe(true);
    expect(win.localStorage.getItem(SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY)).toBe("true");
  });

  it("writes and subscribes to boolean auto-collapse preference changes", () => {
    const { win } = createTestEnvironment();
    const listener = vi.fn();
    const unsubscribe = subscribeSidebarAutoCollapsePreference(win, listener);

    writeSidebarAutoCollapsePreference(false, win, win);
    expect(readSidebarAutoCollapsePreference(win)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    setSidebarAutoCollapsePreference(win, true);
    expect(readSidebarAutoCollapsePreference(win)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setSidebarAutoCollapsePreference(win, false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("installRendererSidebarOverlay threshold collapse", () => {
  it("collapses once when crossing 1140px -> 954px and preserves manual expansion in narrow viewports", () => {
    const env = createTestEnvironment(1140);
    const handle = installRendererSidebarOverlay({
      document: env.doc,
      window: env.win,
    });

    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("true");
    expect(env.getTriggerClicks()).toBe(0);

    // Cross >= 1080px -> < 1080px (1140px -> 954px): triggers native collapse once.
    env.resizeTo(954);
    expect(env.getTriggerClicks()).toBe(1);
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("false");

    // User manually re-opens sidebar at 954px: stays docked across narrow resizes and refreshes.
    env.trigger.click();
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("true");
    expect(env.getTriggerClicks()).toBe(2);

    env.resizeTo(800);
    handle.refresh();
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("true");
    expect(env.getTriggerClicks()).toBe(2);

    // Re-crossing >= 1080px -> < 1080px triggers one collapse again.
    env.resizeTo(1140);
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("true");
    env.resizeTo(954);
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("false");
    expect(env.getTriggerClicks()).toBe(3);

    handle.dispose();
  });

  it("collapses once on initial mount when starting in a narrow viewport (< 1080px)", () => {
    const env = createTestEnvironment(954);
    const handle = installRendererSidebarOverlay({
      document: env.doc,
      window: env.win,
    });

    expect(env.getTriggerClicks()).toBe(1);
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("false");
    handle.dispose();
  });

  it("does not collapse when preference is disabled or migrated from docked", () => {
    const env = createTestEnvironment(1140);
    env.win.localStorage.setItem(SIDEBAR_OVERLAY_MODE_STORAGE_KEY, "docked");

    const handle = installRendererSidebarOverlay({
      document: env.doc,
      window: env.win,
    });

    env.resizeTo(954);
    expect(env.getTriggerClicks()).toBe(0);
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("true");
    handle.dispose();
  });

  it("removes custom overlay CSS, never hides app-shell-floating-left-panel, and injects no pin button", () => {
    expect(buildSidebarOverlayCss()).toBe("");

    const env = createTestEnvironment(954);
    const handle = installRendererSidebarOverlay({
      document: env.doc,
      window: env.win,
    });

    expect(env.doc.querySelectorAll(`[${SIDEBAR_PIN_BUTTON_ATTRIBUTE}]`)).toHaveLength(0);
    expect(env.floatingPanel.style.display).toBeUndefined();
    expect(env.doc.documentElement.hasAttribute("data-codexhost-sidebar-overlay")).toBe(false);
    handle.dispose();
  });
});

describe("Appearance settings boolean switch and localized copy", () => {
  it("provides matching English and Chinese copy for narrow sidebar auto-collapse and top active session strip", () => {
    const zh = rendererSettingsMessages("zh-CN");
    const en = rendererSettingsMessages("en");

    expect(zh.sidebarAutoCollapseTitle).toBe("窄屏自动收起左边栏");
    expect(zh.sidebarAutoCollapseDescription).toContain("1080px");
    expect(zh.sidebarAutoCollapseDescription).toContain("57px");
    expect(zh.topTabsTitle).toBe("顶部活动会话条");
    expect(zh.topTabsDescription).toContain("未读");

    expect(en.sidebarAutoCollapseTitle).toBe("Auto-collapse left sidebar on narrow screens");
    expect(en.sidebarAutoCollapseDescription).toContain("1080px");
    expect(en.sidebarAutoCollapseDescription).toContain("57px");
    expect(en.topTabsTitle).toBe("Top active session strip");
    expect(en.topTabsDescription).toContain("unread");
  });

  it("mounts a boolean switch instead of a select for narrow sidebar auto-collapse", () => {
    const env = createTestEnvironment(1140);
    env.win.localStorage.setItem(SIDEBAR_OVERLAY_MODE_STORAGE_KEY, "docked");

    const zh = rendererSettingsMessages("zh-CN");
    const page = createAppearanceSettingsPage(zh);
    const content = env.doc.createElement("div");
    const controller = new AbortController();
    const dispose = page.mount({
      content: content as unknown as HTMLElement,
      signal: controller.signal,
      runLatest: async () => {},
    });

    const switches: FakeElement[] = [];
    const selects: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      if (node.tagName === "INPUT" && node.getAttribute("role") === "switch") {
        switches.push(node);
      }
      if (node.tagName === "SELECT") {
        selects.push(node);
      }
      for (const child of node.children) walk(child);
    };
    walk(content as unknown as FakeElement);

    // Only archiveChildren uses a <select>; sidebar auto-collapse is now a boolean switch.
    expect(selects).toHaveLength(1);
    const autoCollapseSwitch = switches.find((el) => el.id.includes("sidebar-auto-collapse"));
    expect(autoCollapseSwitch).toBeDefined();
    expect(autoCollapseSwitch?.checked).toBe(false);

    if (autoCollapseSwitch) {
      autoCollapseSwitch.checked = true;
      autoCollapseSwitch.dispatchEvent(new Event("change"));
    }
    expect(readSidebarAutoCollapsePreference(env.win)).toBe(true);

    dispose?.();
  });
});
