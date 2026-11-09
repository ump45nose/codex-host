import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOST_GUARD,
  STANDALONE_GUARD,
  USER_MESSAGE_EVENT,
  emitCodexHostUserMessage,
  installRendererSidebarStash,
} from "../src/renderer-sidebar-stash.js";
import { createStashSection } from "../src/renderer-sidebar-stash/section.js";
import { ZH } from "../src/renderer-sidebar-stash/strings.js";
import { StashStore } from "../src/renderer-sidebar-stash/store.js";
import {
  createSidebarAdapter,
  nativeSectionKey,
  type SidebarAdapter,
} from "../src/renderer-sidebar-stash/adapter.js";

type AttrMap = Map<string, string>;

class FakeNode extends EventTarget {
  parentElement: FakeNode | null = null;
  children: FakeNode[] = [];
  attributes: AttrMap = new Map();
  style: Record<string, string> = {};
  textContent = "";
  hidden = false;
  isConnected = false;
  tagName: string;
  ownerDocument: FakeDocument | null = null;
  className = "";
  type = "";
  value = "";

  constructor(tag = "div") {
    super();
    this.tagName = tag.toUpperCase();
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  getAttributeNames(): string[] {
    return [...this.attributes.keys()];
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  appendChild(node: FakeNode): FakeNode {
    node.parentElement = this;
    node.isConnected = true;
    node.ownerDocument = this.ownerDocument;
    this.children.push(node);
    return node;
  }
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }
  prepend(node: FakeNode): void {
    node.parentElement = this;
    node.isConnected = true;
    node.ownerDocument = this.ownerDocument;
    this.children.unshift(node);
  }
  after(...nodes: FakeNode[]): void {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    let index = parent.children.indexOf(this);
    for (const node of nodes) {
      node.parentElement = parent;
      node.isConnected = true;
      node.ownerDocument = this.ownerDocument;
      index += 1;
      parent.children.splice(index, 0, node);
    }
  }
  get nextSibling(): FakeNode | null {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index >= 0 ? (this.parentElement.children[index + 1] ?? null) : null;
  }
  get previousElementSibling(): FakeNode | null {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index > 0 ? (this.parentElement.children[index - 1] ?? null) : null;
  }
  get parentNode(): FakeNode | null {
    return this.parentElement;
  }
  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    node.parentElement = this;
    node.isConnected = true;
    node.ownerDocument = this.ownerDocument;
    if (!ref) {
      this.children.push(node);
      return node;
    }
    const index = this.children.indexOf(ref);
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    return node;
  }
  remove(): void {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    }
    this.parentElement = null;
    this.isConnected = false;
  }
  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of this.children) {
      child.parentElement = null;
      child.isConnected = false;
    }
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }
  closest(selector: string): FakeNode | null {
    if (this.matches(selector)) return this;
    return this.parentElement ? this.parentElement.closest(selector) : null;
  }
  matches(selector: string): boolean {
    if (selector.startsWith("[") && selector.endsWith("]")) {
      const body = selector.slice(1, -1);
      if (body.includes("=")) {
        const eq = body.indexOf("=");
        const name = body.slice(0, eq);
        const value = body
          .slice(eq + 1)
          .replace(/^"|"$/g, "")
          .replace(/^'|'$/g, "");
        return this.getAttribute(name) === value;
      }
      return this.hasAttribute(body);
    }
    return false;
  }
  querySelector(selector: string): FakeNode | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (node: FakeNode): void => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  get offsetWidth(): number {
    return 220;
  }
  get offsetHeight(): number {
    return 180;
  }
  get BoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 20,
      right: 100,
      width: 100,
      height: 20,
      toJSON() {
        return this;
      },
    } as DOMRect;
  }
  getBoundingClientRect(): DOMRect {
    return this.BoundingClientRect;
  }
}

class FakeDocument extends EventTarget {
  body: FakeNode;
  head: FakeNode;
  documentElement: FakeNode;
  defaultView: FakeWindow;

  constructor(view: FakeWindow) {
    super();
    this.defaultView = view;
    this.body = new FakeNode("body");
    this.head = new FakeNode("head");
    this.documentElement = new FakeNode("html");
    this.body.ownerDocument = this;
    this.head.ownerDocument = this;
    this.documentElement.ownerDocument = this;
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): FakeNode {
    const node = new FakeNode(tag);
    node.ownerDocument = this;
    return node;
  }

  querySelector(selector: string): FakeNode | null {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.documentElement.querySelectorAll(selector);
  }
}

class FakeWindow extends EventTarget {
  innerWidth = 1280;
  innerHeight = 800;
  localStorage: Storage;
  Notification?: typeof Notification;
  [key: string]: unknown;

  constructor(storage: Storage) {
    super();
    this.localStorage = storage;
  }
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    removeItem(key: string) {
      map.delete(key);
    },
    key() {
      return null;
    },
  } as Storage;
}

function mockAdapter(overrides: Partial<SidebarAdapter> = {}): SidebarAdapter & {
  opened: string[];
  mount: FakeNode;
} {
  const mount = new FakeNode("nav");
  mount.setAttribute("data-app-action-sidebar", "1");
  const opened: string[] = [];
  const adapter: SidebarAdapter & { opened: string[]; mount: FakeNode } = {
    mount,
    opened,
    findMountPlacement: () => ({
      parent: mount as unknown as HTMLElement,
      after: null,
      before: null,
      gap: null,
    }),
    findMountPoint: () => mount as unknown as HTMLElement,
    listThreadButtons: () => [],
    findThreadButton: () => null,
    readThreadId: () => null,
    readTitle: () => "Untitled",
    readActiveThreadId: () => "activethread01",
    openThread: (threadId) => {
      opened.push(threadId);
      return true;
    },
    readPinState: () => null,
    restorePin: () => false,
    observe: () => () => {},
    ...overrides,
  };
  return adapter;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("stash section DOM", () => {
  it("renders overdue badge and ordered rows", () => {
    const storage = memoryStorage();
    const win = new FakeWindow(storage);
    const doc = new FakeDocument(win);
    const opened: string[] = [];
    const section = createStashSection({
      document: doc as unknown as Document,
      strings: ZH,
      locale: "zh-CN",
      onOpen: (threadId) => opened.push(threadId),
    });
    const store = new StashStore({
      version: 1,
      updatedAt: "2026-11-05T00:00:00.000Z",
      items: {
        dueitem01: {
          title: "Due one",
          dueAt: "2026-11-01T01:00:00.000Z",
          stashedAt: "2026-10-01T00:00:00.000Z",
        },
        lateritem: {
          title: "Later",
          dueAt: "2026-12-01T01:00:00.000Z",
          stashedAt: "2026-11-04T00:00:00.000Z",
        },
      },
    });
    section.render(store.getState(), Date.parse("2026-11-05T12:00:00.000Z"));
    const rows = section.root.querySelectorAll("[data-codexhost-sidebar-stash-row]");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-thread-id")).toBe("dueitem01");
    expect(rows[0]?.getAttribute("data-overdue")).toBe("1");
    expect(rows[0]?.querySelector("[data-codexhost-sidebar-stash-badge]")?.textContent).toBe(
      "到期",
    );
    (rows[0] as unknown as FakeNode).dispatchEvent(new Event("click"));
    expect(opened).toEqual(["dueitem01"]);
    section.dispose();
  });
});

describe("installRendererSidebarStash", () => {
  it("skips when standalone __codexStash_v1 is present", () => {
    const storage = memoryStorage();
    const win = new FakeWindow(storage);
    win[STANDALONE_GUARD] = { version: 1 };
    const doc = new FakeDocument(win);
    const info = vi.fn();
    const handle = installRendererSidebarStash({
      window: win as unknown as Window & typeof globalThis,
      document: doc as unknown as Document,
      storage,
      adapter: mockAdapter(),
      logger: { info, warn: vi.fn(), debug: vi.fn() },
    });
    expect(handle).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("standalone codex-stash detected"));
  });

  it("mounts under the sidebar, stashes via store, and auto-unstashes on user-message", () => {
    const storage = memoryStorage();
    const win = new FakeWindow(storage);
    const doc = new FakeDocument(win);
    win.document = doc;
    const adapter = mockAdapter({
      readActiveThreadId: () => "activethread01",
      readTitle: () => "Active",
      findThreadButton: () => doc.createElement("button") as unknown as HTMLElement,
    });
    // Provide mount point on the fake document tree.
    doc.body.appendChild(adapter.mount);

    const handle = installRendererSidebarStash({
      window: win as unknown as Window & typeof globalThis,
      document: doc as unknown as Document,
      storage,
      adapter,
      getLocale: () => "zh-CN",
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });
    expect(handle).not.toBeNull();
    if (!handle) throw new Error("expected stash handle");
    expect(adapter.mount.querySelector("[data-codexhost-sidebar-stash-root]")).toBeTruthy();
    expect(win[HOST_GUARD]).toBe(handle);

    handle.store.put({
      threadId: "activethread01",
      title: "Active",
      dueAt: "2026-11-01T00:00:00.000Z",
    });
    handle.refresh();
    expect(adapter.mount.querySelectorAll("[data-codexhost-sidebar-stash-row]")).toHaveLength(1);

    emitCodexHostUserMessage("activethread01", win as unknown as Window);
    expect(handle.store.has("activethread01")).toBe(false);
    expect(adapter.opened).toContain("activethread01");

    handle.dispose();
    expect(win[HOST_GUARD]).toBeUndefined();
  });

  it("respects disabled preference", () => {
    const storage = memoryStorage();
    storage.setItem("codexhost.sidebar-stash.enabled", "0");
    const win = new FakeWindow(storage);
    const doc = new FakeDocument(win);
    const debug = vi.fn();
    const handle = installRendererSidebarStash({
      window: win as unknown as Window & typeof globalThis,
      document: doc as unknown as Document,
      storage,
      adapter: mockAdapter(),
      logger: { info: vi.fn(), warn: vi.fn(), debug },
    });
    expect(handle).toBeNull();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("disabled by preference"));
  });
});

describe("user message event name", () => {
  it("is stable for Harness send-path integration", () => {
    expect(USER_MESSAGE_EVENT).toBe("codexhost:user-message");
  });
});

describe("createSidebarAdapter mount placement", () => {
  function buildSidebarDom(): {
    doc: FakeDocument;
    win: FakeWindow;
    aside: FakeNode;
    scroll: FakeNode;
    list: FakeNode;
    pinned: FakeNode;
    recents: FakeNode;
    recentsWrap: FakeNode;
  } {
    const storage = memoryStorage();
    const win = new FakeWindow(storage);
    const doc = new FakeDocument(win);
    const aside = doc.createElement("aside");
    aside.className = "app-shell-left-panel";
    const rail = doc.createElement("nav");
    rail.setAttribute("data-app-navigation-rail", "true");
    const scroll = doc.createElement("div");
    scroll.setAttribute("data-app-action-sidebar-scroll", "");
    const list = doc.createElement("div");
    const pinnedWrap = doc.createElement("div");
    const pinned = doc.createElement("section");
    pinned.setAttribute("data-app-action-sidebar-section", "");
    pinned.setAttribute("data-app-action-sidebar-section-heading", "Pinned");
    pinnedWrap.appendChild(pinned);
    const recentsWrap = doc.createElement("div");
    recentsWrap.setAttribute("data-sidebar-project-container-id", "chats");
    const recents = doc.createElement("section");
    recents.setAttribute("data-app-action-sidebar-section", "");
    recents.setAttribute("data-app-action-sidebar-section-heading", "Recents");
    recentsWrap.appendChild(recents);
    list.appendChild(pinnedWrap);
    list.appendChild(recentsWrap);
    scroll.appendChild(list);
    aside.appendChild(scroll);
    // Outer shell: rail + aside. A buggy fallback that picks `nav, aside` would
    // prepend into the aside flex row and overlay the header.
    doc.body.appendChild(rail);
    doc.body.appendChild(aside);
    return { doc, win, aside, scroll, list, pinned, recents, recentsWrap };
  }

  it("normalizes Recents heading to recent", () => {
    const section = new FakeNode("section");
    section.setAttribute("data-app-action-sidebar-section", "");
    section.setAttribute("data-app-action-sidebar-section-heading", "Recents");
    expect(nativeSectionKey(section as unknown as Element)).toBe("recent");
  });

  it("places the stash after Recents inside the scroll list, not on the aside shell", () => {
    const { doc, aside, recents, recentsWrap } = buildSidebarDom();
    const adapter = createSidebarAdapter(doc as unknown as Document);
    const placement = adapter.findMountPlacement();
    expect(placement).not.toBeNull();
    expect(placement?.parent).toBe(recentsWrap);
    expect(placement?.after).toBe(recents);
    expect(placement?.parent).not.toBe(aside);

    const storage = memoryStorage();
    const win = new FakeWindow(storage);
    win.document = doc;
    const handle = installRendererSidebarStash({
      window: win as unknown as Window & typeof globalThis,
      document: doc as unknown as Document,
      storage,
      adapter,
      getLocale: () => "zh-CN",
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });
    expect(handle).not.toBeNull();
    const root = doc.querySelector("[data-codexhost-sidebar-stash-root]");
    expect(root).toBeTruthy();
    expect(root?.parentElement).toBe(recentsWrap);
    expect(recents.nextSibling).toBe(root);
    // Must not be a direct child of the outer aside (the overlay bug).
    expect(aside.children.includes(root as FakeNode)).toBe(false);
    handle?.dispose();
  });

  it("does not treat the icon rail nav as a mount point", () => {
    const { doc, aside } = buildSidebarDom();
    // No sections / scroll — only the rail and an empty aside shell.
    aside.replaceChildren();
    const adapter = createSidebarAdapter(doc as unknown as Document);
    expect(adapter.findMountPlacement()).toBeNull();
    expect(adapter.findMountPoint()).toBeNull();
  });
});
