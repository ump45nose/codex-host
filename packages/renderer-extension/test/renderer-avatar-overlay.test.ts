// @vitest-environment jsdom
import { encodeHarnessPluginRoute, harnessIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_OVERLAY_AGENT_MENU_ATTR,
  AVATAR_OVERLAY_AGENT_PILL_ATTR,
  AVATAR_OVERLAY_CARD_AGENT_ATTR,
  AVATAR_OVERLAY_ICON_STYLE_ID,
  PETS_HARNESS_CATALOG_STORAGE_KEY,
  PETS_QUICK_CHAT_AGENT_STORAGE_KEY,
  PETS_THREAD_AGENTS_STORAGE_KEY,
  installRendererAvatarOverlay,
  isAvatarOverlayLocation,
  isAvatarOverlayRendererUrl,
  parseNativeActivityId,
  readPetsThreadAgents,
  writePetsHarnessCatalog,
  writePetsThreadAgents,
  type RendererAvatarOverlayHandle,
} from "../src/renderer-avatar-overlay.js";

/** Returns the element matching `selector`, failing the test when it is missing. */
function find(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  window.localStorage.clear();
});

/** Mirrors the native Pet window: two native activity cards and the Quick Chat bar. */
function setup(presentation = "minimized") {
  document.head.innerHTML = "";
  document.body.innerHTML = `
    <div data-avatar-overlay-size="notification-tray">
      <div data-avatar-overlay-activity-stack-item="local:local:ext-1"><div data-avatar-overlay-activity-text="title">Local Claude</div></div>
      <div data-avatar-overlay-activity-stack-item="remote-host:remote-ssh-discovered:mac-work:r-1"><div data-avatar-overlay-activity-text="title">Remote</div></div>
      <div data-avatar-overlay-activity-stack-item="local:local:codex-1"><div data-avatar-overlay-activity-text="title">Codex</div></div>
    </div>
    <div data-quick-chat-presentation="${presentation}">
      <div class="contents no-drag"><div data-above-composer-portal="true"></div></div>
    </div>`;
  const posted: unknown[] = [];
  class FakeMessagePort {
    postMessage(message: unknown) {
      posted.push(message);
    }
  }
  Object.defineProperty(window, "MessagePort", { value: FakeMessagePort, configurable: true });
  const install = (): RendererAvatarOverlayHandle => {
    const handle = installRendererAvatarOverlay({ document, window });
    disposers.push(handle.dispose);
    return handle;
  };
  return { install, posted, FakeMessagePort };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

const CLAUDE = {
  id: "claude-code",
  name: "Claude Code",
  iconStyle: {
    vector: { viewBox: "0 0 16 16", color: "#d97757", paths: [{ d: "M2 2h12v12H2z" }] },
  },
};

function seedCatalog() {
  writePetsHarnessCatalog(
    { enabledAgents: ["codex", "claude-code"], plugins: [CLAUDE as never] },
    window.localStorage,
  );
  writePetsThreadAgents(
    { "local:ext-1": "claude-code", "remote-ssh-discovered:mac-work:r-1": "claude-code" },
    window.localStorage,
  );
}

const cardAgent = (id: string) =>
  find(`[data-avatar-overlay-activity-stack-item="${id}"]`).getAttribute(
    AVATAR_OVERLAY_CARD_AGENT_ATTR,
  );

describe("Pet storage contract", () => {
  it("recognizes the Pet window URL forms", () => {
    expect(isAvatarOverlayRendererUrl("app://-/index.html?initialRoute=%2Favatar-overlay")).toBe(
      true,
    );
    expect(isAvatarOverlayRendererUrl("app://-/index.html?desktopSurface=avatarOverlay")).toBe(
      true,
    );
    expect(isAvatarOverlayRendererUrl("app://-/index.html?initialRoute=%2F")).toBe(false);
    expect(
      isAvatarOverlayLocation({ href: "app://-/index.html", pathname: "/index.html", search: "" }),
    ).toBe(false);
  });

  it("publishes external thread Agents without rewriting unchanged maps", () => {
    writePetsThreadAgents({ "local:a": "claude-code", "local:b": "codex" }, window.localStorage);
    expect([...readPetsThreadAgents(window.localStorage)]).toEqual([["local:a", "claude-code"]]);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    writePetsThreadAgents({ "local:a": "claude-code", "local:b": "codex" }, window.localStorage);
    expect(setItem).not.toHaveBeenCalledWith(PETS_THREAD_AGENTS_STORAGE_KEY, expect.anything());
    const catalog = { enabledAgents: ["codex", "claude-code"], plugins: [CLAUDE as never] };
    writePetsHarnessCatalog(catalog as never, window.localStorage);
    setItem.mockClear();
    writePetsHarnessCatalog(catalog as never, window.localStorage);
    expect(setItem).not.toHaveBeenCalledWith(PETS_HARNESS_CATALOG_STORAGE_KEY, expect.anything());
    setItem.mockRestore();
  });

  it("parses native activity ids", () => {
    expect(parseNativeActivityId("local:local:t1")).toEqual({ hostId: "local", threadId: "t1" });
    expect(parseNativeActivityId("remote-host:remote-ssh:mac:t2")).toEqual({
      hostId: "remote-ssh:mac",
      threadId: "t2",
    });
    expect(parseNativeActivityId("client-new-thread:x")).toBeNull();
  });
});

describe("installRendererAvatarOverlay", () => {
  it("marks external Harness cards for their Agent icon and leaves Codex cards alone", async () => {
    const { install } = setup();
    seedCatalog();
    install();
    expect(cardAgent("local:local:ext-1")).toBe("claude-code");
    expect(cardAgent("remote-host:remote-ssh-discovered:mac-work:r-1")).toBe("claude-code");
    expect(cardAgent("local:local:codex-1")).toBeNull();
    expect(find(`#${AVATAR_OVERLAY_ICON_STYLE_ID}`).textContent).toContain(
      `[${AVATAR_OVERLAY_CARD_AGENT_ATTR}="claude-code"]`,
    );

    writePetsThreadAgents({ "local:ext-1": "claude-code" }, window.localStorage);
    window.dispatchEvent(new StorageEvent("storage", { key: PETS_THREAD_AGENTS_STORAGE_KEY }));
    await settle();
    expect(cardAgent("remote-host:remote-ssh-discovered:mac-work:r-1")).toBeNull();
  });

  it("shows the Agent picker only while composing, above the bar without taking focus", async () => {
    const { install } = setup("minimized");
    seedCatalog();
    install();
    expect(document.querySelector(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`)).toBeNull();
    find("[data-quick-chat-presentation]").setAttribute(
      "data-quick-chat-presentation",
      "composing",
    );
    await settle();
    const pill = find(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`);
    expect(pill.parentElement?.hasAttribute("data-above-composer-portal")).toBe(true);
    expect(pill.textContent).toBe("Codex");
    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    pill.dispatchEvent(mousedown);
    expect(mousedown.defaultPrevented).toBe(true);

    pill.click();
    const options = [
      ...document.querySelectorAll<HTMLElement>(
        `[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] [role="menuitemradio"]`,
      ),
    ];
    expect(
      options.map((o) => [o.getAttribute("data-agent-option"), o.getAttribute("aria-checked")]),
    ).toEqual([
      ["codex", "true"],
      ["claude-code", "false"],
    ]);
    options[1]?.click();
    expect(window.localStorage.getItem(PETS_QUICK_CHAT_AGENT_STORAGE_KEY)).toBe("claude-code");
    expect(document.querySelector(`[${AVATAR_OVERLAY_AGENT_MENU_ATTR}]`)).toBeNull();
    await settle();
    expect(document.querySelector(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`)?.textContent).toBe(
      "Claude Code",
    );
  });

  it("routes Quick Chat to the selected Harness and leaves Codex untouched", () => {
    const { install, posted, FakeMessagePort } = setup();
    seedCatalog();
    const original = FakeMessagePort.prototype.postMessage;
    window.localStorage.setItem(PETS_QUICK_CHAT_AGENT_STORAGE_KEY, "claude-code");
    const handle = install();
    const frame = (model: string) => [
      "push",
      [
        "pipeline",
        0,
        ["startConversation"],
        [{ collaborationMode: { settings: { model } }, config: { model } }],
      ],
    ];
    const port = new FakeMessagePort();
    port.postMessage(frame("gpt-5.5"));
    const route = encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("claude-code") });
    expect(JSON.stringify(posted[0])).toContain(`"model":"${route}"`);
    expect(JSON.stringify(posted[0])).not.toContain("gpt-5.5");

    window.localStorage.setItem(PETS_QUICK_CHAT_AGENT_STORAGE_KEY, "codex");
    port.postMessage(frame("gpt-5.5"));
    expect(JSON.stringify(posted[1])).toContain('"model":"gpt-5.5"');

    handle.dispose();
    expect(FakeMessagePort.prototype.postMessage).toBe(original);
  });

  it("removes everything it added on dispose and leaves native nodes untouched", () => {
    const { install } = setup("composing");
    seedCatalog();
    const before = document.body.innerHTML;
    const handle = install();
    expect(document.body.innerHTML).not.toBe(before);
    handle.dispose();
    expect(document.body.innerHTML).toBe(before);
    expect(document.getElementById(AVATAR_OVERLAY_ICON_STYLE_ID)).toBeNull();
  });
});
