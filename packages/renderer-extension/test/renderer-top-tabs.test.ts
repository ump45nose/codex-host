// @vitest-environment jsdom
import { harnessPluginDescriptorSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";
import * as avatar from "../src/renderer-avatar-overlay.js";
import { SIDEBAR_AGENT_ICON_ATTRIBUTE } from "../src/renderer-sidebar-agent-icons.js";
import * as topTabs from "../src/renderer-top-tabs.js";

function createFixture(specs: string[]) {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 800, configurable: true, writable: true });
  document.head.innerHTML = "";
  const rowsHtml = specs
    .map((spec) => {
      const [id = "", status = "idle", agent = "codex", active = "", hostId = "local"] =
        spec.split("|");
      return `<a data-app-action-sidebar-thread-row="true" data-app-action-sidebar-thread-host-id="${hostId}" data-app-action-sidebar-thread-id="${hostId}:${id}" data-thread-title="Title ${id}" data-thread-status="${status}" ${active ? 'data-active="true"' : ""}><span ${SIDEBAR_AGENT_ICON_ATTRIBUTE}="${agent}"></span></a>`;
    })
    .join("");
  document.body.innerHTML = `<header data-app-shell-titlebar="true"></header><aside data-app-action-sidebar-section="recent">${rowsHtml}</aside><main class="page-surface PageSurface" data-app-shell-active-page="true"><div></div></main>`;
  const titlebar = document.querySelector<HTMLElement>("header") ?? document.createElement("div");
  const sidebar = document.querySelector<HTMLElement>("aside") ?? document.createElement("div");
  const surface = document.querySelector<HTMLElement>("main") ?? document.createElement("div");
  const rowEls = [...sidebar.querySelectorAll<HTMLElement>("a")];
  for (const r of rowEls) {
    r.addEventListener("click", () => {
      for (const s of rowEls) s.removeAttribute("data-active");
      r.setAttribute("data-active", "true");
    });
  }
  const install = (extra?: topTabs.InstallRendererTopTabsOptions) =>
    topTabs.installRendererTopTabs({ document, window, ...extra });
  const q = (s: string) => surface.querySelector<HTMLElement>(s);
  const qa = (s: string) => [...surface.querySelectorAll<HTMLElement>(s)];
  const tabKeys = () =>
    qa(`[${topTabs.TOP_TAB_ATTRIBUTE}]`).map((t) => t.getAttribute(topTabs.TOP_TAB_ATTRIBUTE));
  return { titlebar, surface, rowEls, install, q, qa, tabKeys };
}

const CLAUDE_PLUGIN = harnessPluginDescriptorSchema.parse({
  id: "claude-code",
  name: "Claude Code",
  version: "1.0.0",
  iconStyle: {
    vector: { viewBox: "0 0 16 16", color: "#d97757", paths: [{ d: "M2 2h12v12H2z" }] },
  },
});

describe("renderer-top-tabs (PageSurface active session strip)", () => {
  it("mounts inside PageSurface top, filters active/unread statuses, and removes close/overflow controls", () => {
    const f = createFixture([
      "t-run|running|codex|1",
      "t-wait|waiting|claude",
      "t-unread|unread|gemini",
      "t-fail|failed|pi",
      "t-idle-1|idle|codex",
      "t-idle-2|idle|claude",
    ]);
    const h = f.install();
    expect(f.titlebar.querySelector(`[${topTabs.TOP_TABS_ROOT_ATTRIBUTE}]`)).toBeNull();
    const strip = f.q(`[${topTabs.TOP_TABS_ROOT_ATTRIBUTE}]`);
    expect(f.surface.firstElementChild).toBe(strip);
    expect(strip?.getAttribute("data-hidden")).toBe("false");
    expect(f.tabKeys()).toEqual(["local:t-run", "local:t-wait", "local:t-unread", "local:t-fail"]);
    expect(f.q("[data-codexhost-top-tab-close]")).toBeNull();
    expect(f.q("[data-codexhost-top-tabs-more]")).toBeNull();
    h.dispose();
  });

  it("retains temporary reading lease (viewedLeaseKey) when unread becomes idle while viewed, and exits on switch", () => {
    const f = createFixture(["t-run|running|codex|1", "t-unread|unread|claude"]);
    const h = f.install();
    f.q(`[${topTabs.TOP_TAB_ATTRIBUTE}="local:t-unread"]`)?.click();
    f.rowEls[1]?.setAttribute("data-thread-status", "idle");
    h.refresh();
    expect(f.tabKeys()).toEqual(["local:t-run", "local:t-unread"]);
    expect(f.q('[data-session-slot="local:t-unread"]')?.getAttribute("data-selected")).toBe("true");
    f.q(`[${topTabs.TOP_TAB_ATTRIBUTE}="local:t-run"]`)?.click();
    expect(f.tabKeys()).toEqual(["local:t-run"]);
    h.dispose();
  });

  it("acknowledges failed sessions when viewed, exits on switch, and resets if re-entering running | waiting", () => {
    const f = createFixture(["t-run|running|codex|1", "t-fail|failed|claude"]);
    const ack = new Set<string>();
    const h = f.install({ acknowledgedFailedKeys: ack });
    expect(ack.has("local:t-fail")).toBe(false);
    f.q(`[${topTabs.TOP_TAB_ATTRIBUTE}="local:t-fail"]`)?.click();
    expect(ack.has("local:t-fail")).toBe(true);
    expect(f.tabKeys()).toEqual(["local:t-run", "local:t-fail"]);
    f.q(`[${topTabs.TOP_TAB_ATTRIBUTE}="local:t-run"]`)?.click();
    expect(f.tabKeys()).toEqual(["local:t-run"]);
    f.rowEls[1]?.setAttribute("data-thread-status", "running");
    h.refresh();
    expect(ack.has("local:t-fail")).toBe(false);
    f.rowEls[1]?.setAttribute("data-thread-status", "failed");
    h.refresh();
    expect(f.tabKeys()).toEqual(["local:t-run", "local:t-fail"]);
    h.dispose();
  });

  it("collapses container height (data-hidden='true') when 0 sessions match or preference is disabled", () => {
    const f = createFixture(["t-1|running|codex"]);
    const h = f.install();
    const strip = f.q(`[${topTabs.TOP_TABS_ROOT_ATTRIBUTE}]`);
    f.rowEls[0]?.setAttribute("data-thread-status", "idle");
    h.refresh();
    expect(strip?.getAttribute("data-hidden")).toBe("true");
    expect(strip?.children.length).toBe(0);
    f.rowEls[0]?.setAttribute("data-thread-status", "running");
    h.refresh();
    topTabs.setTopTabsEnabledPreference(window, false);
    h.refresh();
    expect(strip?.getAttribute("data-hidden")).toBe("true");
    h.dispose();
  });

  it("isolates composite keys (hostId, threadId), resolves short remote host labels, and redraws async plugin icons", () => {
    const f = createFixture([
      "shared-99|running|claude-code|1|local",
      "shared-99|waiting|claude||macpro.local",
      "shared-99|unread|gemini||ssh-nas",
    ]);
    const state: { plugin?: typeof CLAUDE_PLUGIN } = {};
    const h = f.install({
      getHostLabel: (id) => (id === "ssh-nas" ? "root@nas.lan:22" : null),
      getThreadAgent: (_h, _t, fb) => ({
        agent: fb ?? "claude-code",
        ...(state.plugin ? { plugin: state.plugin } : {}),
      }),
    });
    expect(f.tabKeys()).toEqual(["local:shared-99", "macpro.local:shared-99", "ssh-nas:shared-99"]);
    const tabs = f.qa(`[${topTabs.TOP_TAB_ATTRIBUTE}]`);
    expect(tabs[0]?.querySelector(".s-host-badge")).toBeNull();
    expect(tabs[1]?.querySelector(".s-host-badge")?.textContent).toBe("MacPro");
    expect(tabs[2]?.querySelector(".s-host-badge")?.textContent).toBe("NAS");
    expect(topTabs.resolveShortHostLabel("ssh://user@192.168.1.50:2222")).toBe("192.168.1.50");

    const slot = () => f.q('[data-session-slot="local:shared-99"]');
    const sig = (p?: typeof CLAUDE_PLUGIN) => topTabs.computeAgentIconSignature("claude-code", p);
    expect(slot()?.getAttribute("data-icon-signature")).toBe(sig(undefined));
    expect(slot()?.querySelector(".s-icon svg")).toBeNull();
    state.plugin = CLAUDE_PLUGIN;
    h.refresh();
    expect(slot()?.getAttribute("data-icon-signature")).toBe(sig(CLAUDE_PLUGIN));
    expect(slot()?.querySelector(".s-icon svg")).not.toBeNull();
    h.dispose();
  });

  it("steps down density to compact-icons for 6+ sessions, locks slot width on hover, and syncs Pet storage", () => {
    const f = createFixture(
      "t-1|running|codex|1|local,t-2|waiting|claude-code||local,t-3|unread|gemini||local,t-4|running|pi||local,t-5|failed|claude-code||macpro.local,t-6|running|hermes||local".split(
        ",",
      ),
    );
    expect(topTabs.computeTopTabsDensity(752, 6)).toBe("compact-icons");
    const h = f.install();
    expect(f.q(".session-pill-track")?.getAttribute("data-density")).toBe("compact-icons");
    const bgSlot = f.q('[data-session-slot="local:t-2"]');
    if (bgSlot) {
      Object.defineProperty(bgSlot, "offsetWidth", { value: 42, configurable: true });
      bgSlot.dispatchEvent(new Event("pointerenter"));
    }
    expect(bgSlot?.getAttribute("data-floating")).toBe("true");
    expect(bgSlot?.style.width).toBe("42px");
    bgSlot?.dispatchEvent(new Event("pointerleave"));
    expect(bgSlot?.getAttribute("data-floating")).toBeNull();

    const ack = new Set<string>();
    const snaps = topTabs.collectSidebarThreads(document, (_h, _t, fb) => ({
      agent: fb ?? "codex",
      ...(fb === "claude-code" ? { plugin: CLAUDE_PLUGIN } : {}),
    }));
    const ls = window.localStorage;
    const sync = () =>
      avatar.writePetsRemoteThreads(
        [...snaps.values()]
          .filter(
            (i) =>
              (i.hostId !== "local" || i.agent !== "codex") &&
              topTabs.isUnreadOrActiveSessionStatus(i.status, `${i.hostId}:${i.threadId}`, ack),
          )
          .map((i) => {
            const hostLabel = topTabs.resolveShortHostLabel(i.hostId);
            return { ...i, ...(hostLabel ? { hostLabel } : {}) };
          }),
        ls,
      );
    sync();
    const keys = avatar.readPetsRemoteThreads(ls).map((s) => `${s.hostId}:${s.threadId}`);
    expect(keys).toEqual(["local:t-2", "local:t-3", "local:t-4", "macpro.local:t-5", "local:t-6"]);
    ack.add("macpro.local:t-5");
    sync();
    expect(avatar.readPetsRemoteThreads(ls).some((s) => s.threadId === "t-5")).toBe(false);
    const catalog = { enabledAgents: ["codex", "claude-code"], plugins: [CLAUDE_PLUGIN] };
    avatar.writePetsHarnessCatalog(catalog, ls);
    expect(avatar.readPetsHarnessCatalog(ls)?.plugins[0]?.id).toBe("claude-code");
    expect(topTabs.rollupTopTabStatus(["idle", "unread", "running"])).toBe("running");
    expect(avatar.PETS_OPEN_THREAD_REQUEST_STORAGE_KEY).toContain("pets-open-thread-request");
    h.dispose();
  });
});
