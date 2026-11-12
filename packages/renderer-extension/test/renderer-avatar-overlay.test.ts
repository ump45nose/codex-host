import { encodeHarnessPluginRoute, harnessIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AVATAR_OVERLAY_AGENT_MENU_ATTR,
  AVATAR_OVERLAY_AGENT_PILL_ATTR,
  AVATAR_OVERLAY_NATIVE_ICON_ATTR,
  AVATAR_OVERLAY_NATIVE_TITLE_ATTR,
  AVATAR_OVERLAY_REMOTE_ITEM_ATTR,
  AVATAR_OVERLAY_REMOTE_LIST_ATTR,
  AVATAR_OVERLAY_ROOT_ATTR,
  PETS_REMOTE_THREADS_STORAGE_KEY,
  buildAvatarOverlayCss,
  clearPetsOpenThreadRequest,
  installRendererAvatarOverlay,
  isAvatarOverlayLocation,
  isAvatarOverlayRendererUrl,
  readPetsHarnessCatalog,
  readPetsOpenThreadRequest,
  readPetsRemoteThreads,
  requestPetsOpenThreadInMainWindow,
  writePetsHarnessCatalog,
  writePetsRemoteThreads,
} from "../src/renderer-avatar-overlay.js";
import { writeNewThreadAgentPreference } from "../src/renderer-new-thread-preference.js";

class FakeElement extends EventTarget {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  tagName: string;
  id = "";
  className = "";
  textContent = "";
  title = "";
  type = "";
  src = "";
  alt = "";
  draggable = false;
  rect = { top: 40, left: 20, right: 320, bottom: 80, width: 300, height: 40 };

  constructor(
    tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {
    super();
    this.tagName = tagName.toUpperCase();
  }
  getAttribute(n: string): string | null {
    return n === "id"
      ? this.id || null
      : n === "class"
        ? this.className || null
        : (this.attributes.get(n) ?? null);
  }
  setAttribute(n: string, v: string): void {
    const s = String(v);
    if (n === "id") this.id = s;
    if (n === "class") this.className = s;
    this.attributes.set(n, s);
  }
  removeAttribute(n: string): void {
    if (n === "id") this.id = "";
    if (n === "class") this.className = "";
    this.attributes.delete(n);
  }
  hasAttribute(n: string): boolean {
    return this.getAttribute(n) !== null;
  }
  appendChild(c: FakeElement): FakeElement {
    c.remove();
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  append(...nodes: (FakeElement | string)[]): void {
    for (const n of nodes) if (n instanceof FakeElement) this.appendChild(n);
  }
  prepend(c: FakeElement): void {
    c.remove();
    c.parentElement = this;
    this.children.unshift(c);
  }
  replaceChildren(...nodes: (FakeElement | string)[]): void {
    for (const c of this.children) c.parentElement = null;
    this.children.length = 0;
    this.append(...nodes);
  }
  remove(): void {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
  }
  contains(o: unknown): boolean {
    return o === this || this.children.some((c) => c.contains(o));
  }
  getBoundingClientRect() {
    return this.rect;
  }
  click(): void {
    this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
  }

  matchesSingle(rawSelector: string): boolean {
    let s = rawSelector.trim();
    const notMatch = /^(.*):not\(\[([^\]=]+)\]?\)$/u.exec(s);
    if (notMatch) {
      if (this.hasAttribute((notMatch[2] ?? "").trim())) return false;
      s = (notMatch[1] ?? "").trim();
    }
    if (s.startsWith(".")) {
      const tokens = new Set(this.className.split(/\s+/u).filter(Boolean));
      return s
        .slice(1)
        .split(".")
        .filter(Boolean)
        .every((c) => tokens.has(c));
    }
    const prefix = /^\[([^\]^=]+)\^="([^"]*)"\]$/u.exec(s);
    if (prefix) return (this.getAttribute(prefix[1] ?? "") ?? "").startsWith(prefix[2] ?? "");
    const exact = /^\[([^\]=]+)="([^"]*)"\]$/u.exec(s);
    if (exact) return this.getAttribute(exact[1] ?? "") === (exact[2] ?? "");
    const hasAttr = /^\[([^\]]+)\]$/u.exec(s);
    if (hasAttr) return this.hasAttribute(hasAttr[1] ?? "");
    const childTag = /^\[([^\]]+)\]\s+([a-zA-Z0-9_-]+)$/u.exec(s);
    if (childTag)
      return (
        this.tagName === (childTag[2] ?? "").toUpperCase() &&
        Boolean(this.parentElement?.hasAttribute(childTag[1] ?? ""))
      );
    return Boolean(s) && this.tagName === s.toUpperCase();
  }

  querySelector<T extends FakeElement = FakeElement>(s: string): T | null {
    return (this.querySelectorAll(s)[0] as T | undefined) ?? null;
  }
  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const parts = selector
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const results: T[] = [];
    const visit = (n: FakeElement): void => {
      for (const c of n.children) {
        if (parts.some((p) => c.matchesSingle(p))) results.push(c as T);
        visit(c);
      }
    };
    visit(this);
    return results;
  }
}

class FakeDocument extends EventTarget {
  readonly documentElement = new FakeElement("html", this);
  readonly head = new FakeElement("head", this);
  readonly body = new FakeElement("body", this);
  defaultView: Window | null = null;
  constructor() {
    super();
    this.documentElement.append(this.head, this.body);
  }
  createElement = (tag: string) => new FakeElement(tag, this);
  createElementNS = (_ns: string, tag: string) => new FakeElement(tag, this);
  getElementById = (id: string) => this.head.children.find((n) => n.id === id) ?? null;
  querySelector = <T extends FakeElement = FakeElement>(s: string) =>
    this.documentElement.querySelector<T>(s);
  querySelectorAll = <T extends FakeElement = FakeElement>(s: string) =>
    this.documentElement.querySelectorAll<T>(s);
}

function createAvatarOverlayFixture() {
  const doc = new FakeDocument();
  const storageMap = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storageMap.set(k, String(v));
    },
    removeItem: (k: string) => {
      storageMap.delete(k);
    },
  };
  const postMessageSpy = vi.fn();
  class FakeMessagePort {
    postMessage(message: unknown, ...rest: unknown[]): void {
      postMessageSpy(message, ...rest);
    }
  }
  const win = Object.assign(new EventTarget(), {
    innerWidth: 420,
    innerHeight: 900,
    screen: { availHeight: 1080 },
    localStorage,
    MessagePort: FakeMessagePort,
  }) as unknown as Window & {
    localStorage: typeof localStorage;
    MessagePort: typeof FakeMessagePort;
  };
  doc.defaultView = win;

  writePetsHarnessCatalog(
    {
      enabledAgents: ["codex", "claude-code", "hermes"],
      plugins: [
        {
          id: harnessIdSchema.parse("claude-code"),
          name: "Claude Code",
          iconStyle: {
            vector: {
              color: "#D97757",
              viewBox: "0 0 24 24",
              paths: [{ d: "M12 2L15 9H9L12 2Z" }],
            },
          },
        },
        {
          id: harnessIdSchema.parse("hermes"),
          name: "Hermes Agent",
          icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
      ],
    },
    localStorage,
  );

  const mkStack = (size: string) => {
    const el = doc.createElement("div");
    el.setAttribute("data-avatar-overlay-size", size);
    el.style.height = "92px";
    return el;
  };
  const [tray, trayList, visibleLayout, backingLayout] = [
    mkStack("notification-tray"),
    mkStack("notification-tray-list"),
    mkStack("notification-stack-visible-layout"),
    mkStack("notification-stack-backing-layout"),
  ];
  const composer = doc.createElement("form");
  composer.setAttribute("data-avatar-overlay-native-surface-id", "composer");
  composer.setAttribute("data-avatar-overlay-hit-region", "notification-composer");
  const previewLog = doc.createElement("div");
  previewLog.setAttribute("role", "log");
  visibleLayout.appendChild(backingLayout);
  trayList.append(composer, visibleLayout);
  tray.appendChild(trayList);
  doc.body.append(tray, previewLog);
  return {
    doc,
    win,
    localStorage,
    tray,
    trayList,
    composer,
    visibleLayout,
    backingLayout,
    previewLog,
    postMessageSpy,
    FakeMessagePort,
  };
}

describe("Renderer Avatar Overlay (Pet)", () => {
  it("recognizes real ?initialRoute=%2Favatar-overlay, desktopSurface, and legacy URLs", () => {
    for (const u of [
      "app://-/index.html?initialRoute=%2Favatar-overlay",
      "app://-/index.html?initialRoute=/avatar-overlay",
      "app://-/index.html?desktopSurface=avatarOverlay",
      "app://-/avatar-overlay.html",
    ]) {
      expect(isAvatarOverlayRendererUrl(u)).toBe(true);
    }
    expect(isAvatarOverlayRendererUrl("app://-/index.html?initialRoute=%2F")).toBe(false);
    expect(
      isAvatarOverlayLocation({
        href: "app://-/index.html?initialRoute=%2Favatar-overlay",
        pathname: "/index.html",
        search: "?initialRoute=%2Favatar-overlay",
      }),
    ).toBe(true);
    expect(
      isAvatarOverlayLocation({
        href: "app://-/index.html",
        pathname: "/index.html",
        search: "?desktopSurface=avatarOverlay",
      }),
    ).toBe(true);
    expect(
      isAvatarOverlayLocation({ href: "app://-/index.html", pathname: "/index.html", search: "" }),
    ).toBe(false);
  });

  it("reads and writes local external and remote active threads while filtering out idle items", () => {
    const { localStorage } = createAvatarOverlayFixture();
    writePetsRemoteThreads(
      [
        {
          hostId: "local",
          threadId: "thr-local-ext",
          title: "Local Claude Code Task",
          status: "running",
          agent: "claude-code",
        },
        {
          hostId: "ssh-macpro",
          hostLabel: "MacPro",
          threadId: "thr-remote-wait",
          title: "Remote Waiting Approval",
          status: "waiting",
          agent: "hermes",
        },
        {
          hostId: "local",
          threadId: "thr-failed",
          title: "Unread Failed Task",
          status: "failed",
          agent: "claude-code",
        },
        {
          hostId: "local",
          threadId: "thr-idle",
          title: "Completed Idle Task",
          status: "idle",
          agent: "claude-code",
        },
      ],
      localStorage,
    );
    expect(
      readPetsRemoteThreads(localStorage).map((i) => `${i.hostId}:${i.threadId}:${i.status}`),
    ).toEqual([
      "local:thr-local-ext:running",
      "ssh-macpro:thr-remote-wait:waiting",
      "local:thr-failed:failed",
    ]);
  });

  it("renders enabled external Harnesses and authentic plugin icons in Quick Chat when 0 active threads exist", () => {
    const { doc, win, localStorage, composer } = createAvatarOverlayFixture();
    writePetsRemoteThreads([], localStorage);
    const handle = installRendererAvatarOverlay({
      document: doc as unknown as Document,
      window: win,
    });
    expect(doc.documentElement.getAttribute(AVATAR_OVERLAY_ROOT_ATTR)).toBe("true");
    const pill = composer.querySelector(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`);
    expect(pill?.getAttribute("data-avatar-overlay-hit-region")).toBe("notification-composer");

    pill?.click();
    const menu = composer.querySelector(`[${AVATAR_OVERLAY_AGENT_MENU_ATTR}]`);
    expect(menu?.parentElement).toBe(composer);
    expect(menu?.getAttribute("data-avatar-overlay-hit-region")).toBe("notification-composer");
    expect(doc.body.children.some((el) => el.hasAttribute(AVATAR_OVERLAY_AGENT_MENU_ATTR))).toBe(
      false,
    );

    const options = menu?.querySelectorAll("[data-agent-option]") ?? [];
    expect(options.map((o) => o.getAttribute("data-agent-option"))).toEqual([
      "codex",
      "claude-code",
      "hermes",
    ]);
    expect(options[1]?.querySelector("svg")).not.toBeNull();
    expect(options[2]?.querySelector("img")?.src).toContain("data:image/png;base64,");

    options[1]?.click();
    expect(pill?.getAttribute("data-agent")).toBe("claude-code");
    expect(pill?.querySelector("svg")).not.toBeNull();
    expect(readPetsHarnessCatalog(localStorage)?.enabledAgents).toEqual([
      "codex",
      "claude-code",
      "hermes",
    ]);
    handle.dispose();
  });

  it("enhances native activity cards in-place without duplication, appends unmatched active pills, lifts stack height to min(520px, 60vh), and keeps left preview bubble untouched", () => {
    const { doc, win, localStorage, tray, trayList, visibleLayout, backingLayout, previewLog } =
      createAvatarOverlayFixture();
    const nativeCard = doc.createElement("div");
    nativeCard.setAttribute(
      "data-avatar-overlay-native-surface-id",
      "activity-local:local:thr-native-1",
    );
    const nativeTitle = doc.createElement("span");
    nativeTitle.className = "truncate";
    nativeTitle.textContent = "Native External Thread";
    nativeCard.appendChild(nativeTitle);
    backingLayout.appendChild(nativeCard);

    localStorage.setItem(
      PETS_REMOTE_THREADS_STORAGE_KEY,
      JSON.stringify([
        {
          hostId: "local",
          threadId: "thr-native-1",
          title: "Native External Thread",
          status: "running",
          agent: "claude-code",
        },
        {
          hostId: "local",
          threadId: "thr-appended-local",
          title: "Appended Local Hermes Thread",
          status: "waiting",
          agent: "hermes",
        },
        {
          hostId: "ssh-nas",
          hostLabel: "NAS",
          threadId: "thr-appended-remote",
          title: "Appended Remote Thread",
          status: "unread",
          agent: "claude-code",
        },
        {
          hostId: "local",
          threadId: "thr-idle-ignored",
          title: "Idle Thread",
          status: "idle",
          agent: "claude-code",
        },
      ]),
    );

    const handle = installRendererAvatarOverlay({
      document: doc as unknown as Document,
      window: win,
    });
    for (const c of [tray, trayList, visibleLayout, backingLayout]) {
      expect(c.style.height).toBe("auto");
      expect(c.style.maxHeight).toBe("min(520px, 60vh)");
    }
    expect(previewLog.hasAttribute("data-codexhost-pets-preview-expanded")).toBe(false);
    expect(buildAvatarOverlayCss(520)).toContain("resize: none !important;");
    expect(nativeCard.getAttribute("data-avatar-overlay-hit-region")).toBe("activity-pill");
    expect(nativeCard.querySelector(`[${AVATAR_OVERLAY_NATIVE_ICON_ATTR}] svg`)).not.toBeNull();
    expect(nativeTitle.getAttribute(AVATAR_OVERLAY_NATIVE_TITLE_ATTR)).toBe("true");

    const appendedPills =
      backingLayout
        .querySelector(`[${AVATAR_OVERLAY_REMOTE_LIST_ATTR}]`)
        ?.querySelectorAll(`[${AVATAR_OVERLAY_REMOTE_ITEM_ATTR}]`) ?? [];
    expect(appendedPills.map((p) => p.getAttribute(AVATAR_OVERLAY_REMOTE_ITEM_ATTR))).toEqual([
      "local:thr-appended-local",
      "ssh-nas:thr-appended-remote",
    ]);
    for (const pill of appendedPills) {
      expect(pill.className).toContain("Material-oi9n4Q activityPill-s8lFCN");
      expect(pill.getAttribute("data-avatar-overlay-hit-region")).toBe("activity-pill");
      expect(pill.getAttribute("data-avatar-overlay-native-corner-radius")).toBe("28");
    }
    expect(appendedPills[0]?.querySelector("[data-remote-host-badge]")).toBeNull();
    expect(appendedPills[1]?.querySelector("[data-remote-host-badge]")?.textContent).toBe("[NAS]");

    appendedPills[1]?.click();
    expect(readPetsOpenThreadRequest(localStorage)).toMatchObject({
      hostId: "ssh-nas",
      threadId: "thr-appended-remote",
    });
    clearPetsOpenThreadRequest(localStorage);
    expect(readPetsOpenThreadRequest(localStorage)).toBeNull();
    requestPetsOpenThreadInMainWindow(
      { hostId: "local", threadId: "thr-appended-local" },
      localStorage,
    );
    expect(readPetsOpenThreadRequest(localStorage)?.threadId).toBe("thr-appended-local");
    handle.dispose();
  });

  it("rewrites capnweb startConversation MessagePort frames with encodeHarnessPluginRoute in both collaborationMode.settings.model and config.model", () => {
    const { doc, win, localStorage, postMessageSpy, FakeMessagePort } =
      createAvatarOverlayFixture();
    const originalProtoPostMessage = FakeMessagePort.prototype.postMessage;
    writeNewThreadAgentPreference("claude-code", localStorage);

    const handle = installRendererAvatarOverlay({
      document: doc as unknown as Document,
      window: win,
    });
    const port = new FakeMessagePort();
    const inputPayload = {
      workspaceRoots: ["/tmp/project"],
      collaborationMode: {
        mode: "default",
        settings: { model: "gpt-5.3-codex", reasoning_effort: "medium" },
      },
      config: { model: "gpt-5.3-codex" },
    };
    port.postMessage(["push", ["pipeline", 0, ["startConversation"], [inputPayload, {}]]]);

    const expectedRoute = encodeHarnessPluginRoute({
      harnessId: harnessIdSchema.parse("claude-code"),
    });
    expect(postMessageSpy).toHaveBeenCalledOnce();
    expect(inputPayload.collaborationMode.settings.model).toBe(expectedRoute);
    expect(inputPayload.config.model).toBe(expectedRoute);

    writeNewThreadAgentPreference("codex", localStorage);
    const codexInput = {
      collaborationMode: { mode: "default", settings: { model: "gpt-5.3-codex" } },
      config: { model: "gpt-5.3-codex" },
    };
    port.postMessage(["push", ["pipeline", 0, ["startConversation"], [codexInput]]]);
    expect(codexInput.collaborationMode.settings.model).toBe("gpt-5.3-codex");
    expect(codexInput.config.model).toBe("gpt-5.3-codex");

    handle.dispose();
    expect(FakeMessagePort.prototype.postMessage).toBe(originalProtoPostMessage);
  });
});
