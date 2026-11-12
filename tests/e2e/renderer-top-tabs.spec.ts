import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const exe =
  process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH ??
  (fs.existsSync(chromium.executablePath())
    ? undefined
    : fs.existsSync(chrome)
      ? chrome
      : undefined);
if (exe) test.use({ launchOptions: { executablePath: exe } });

const repoRoot = path.resolve(import.meta.dirname, "../..");
const shotDir = path.resolve(repoRoot, ".spec/screenshots");
fs.mkdirSync(shotDir, { recursive: true });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import * as topTabs from "./packages/renderer-extension/src/renderer-top-tabs.ts";
      import * as sidebarOverlay from "./packages/renderer-extension/src/renderer-sidebar-overlay.ts";
      import * as avatarOverlay from "./packages/renderer-extension/src/renderer-avatar-overlay.ts";
      const PLUGINS = [
        ["claude-code", "Claude Code", "#d97757", "M12 2L15 9L22 9L16 14L18 21L12 17L6 21L8 14L2 9L9 9Z"],
        ["gemini", "Gemini CLI", "#3b82f6", "M12 2C14 8 16 10 22 12C16 14 14 16 12 22C10 16 8 14 2 12C8 10 10 8 12 2Z"],
        ["pi", "Pi Coding Agent", "#059669", "M4 6H20V9H16V18H13V9H10V18H7V9H4V6Z"],
        ["hermes", "Hermes Agent", "#8b5cf6", "M3 12L12 4L21 12L12 20L3 12Z"],
      ].map(([id, name, color, d]) => ({ id, name, version: "1.0.0", iconStyle: { vector: { viewBox: "0 0 24 24", color, paths: [{ d }] } } }));
      const SIX_SESSIONS = [
        ["local", "thr-1", "Refactor Auth & JWT", "running", "claude-code", true],
        ["macpro.local", "thr-2", "Approve Migration Plan", "waiting", "claude-code", false],
        ["local", "thr-3", "E2E Visual Regression", "unread", "codex", false],
        ["nas.lan", "thr-4", "Sync Vector Index", "running", "gemini", false],
        ["macair.local", "thr-5", "Fix Hydration Mismatch", "failed", "pi", false],
        ["local", "thr-6", "Update OpenAPI Schema", "running", "hermes", false],
      ];
      window.mountTestWorkbench = (sessions = SIX_SESSIONS) => {
        const c = document.getElementById("sidebar-rows"); if (!c) return;
        for (const [hostId, threadId, title, status, agent, active] of sessions) {
          const r = c.appendChild(document.createElement("a")); r.id = "row-" + threadId;
          for (const [k, v] of [["data-app-action-sidebar-thread-row", "true"], ["data-app-action-sidebar-thread-host-id", hostId], ["data-app-action-sidebar-thread-id", hostId + ":" + threadId], ["data-thread-status", status]]) r.setAttribute(k, v);
          if (active) r.setAttribute("data-active", "true");
          const ic = document.createElement("span"); ic.setAttribute("data-codexhost-sidebar-agent-icon", agent);
          const ti = document.createElement("span"); ti.setAttribute("data-thread-title", "true"); ti.textContent = title;
          r.append(ic, ti);
          r.addEventListener("click", () => { for (const o of c.querySelectorAll("a")) o.removeAttribute("data-active"); r.setAttribute("data-active", "true"); });
        }
        const pMap = new Map(PLUGINS.map((p) => [p.id, p]));
        window.__topTabsHandle = topTabs.installRendererTopTabs({ document, window, getThreadAgent: (_h, _t, fb) => ({ agent: fb ?? "codex", ...(fb && pMap.has(fb) ? { plugin: pMap.get(fb) } : {}) }) });
        window.__sidebarOverlayHandle = sidebarOverlay.installRendererSidebarOverlay({ document, window });
      };
      window.mountPetWorkbench = () => {
        const ls = window.localStorage;
        avatarOverlay.writePetsHarnessCatalog({ enabledAgents: ["codex", "claude-code", "gemini", "pi"], plugins: PLUGINS.slice(0, 3) }, ls);
        avatarOverlay.writePetsRemoteThreads([
          { hostId: "local", threadId: "thr-local-claude", title: "Local Claude Refactor", status: "running", agent: "claude-code", plugin: PLUGINS[0] },
          { hostId: "macpro.local", hostLabel: "MacPro", threadId: "thr-macpro-wait", title: "Approve Release Tag", status: "waiting", agent: "gemini", plugin: PLUGINS[1] },
          { hostId: "nas.lan", hostLabel: "NAS", threadId: "thr-nas-unread", title: "Backup Complete", status: "unread", agent: "pi", plugin: PLUGINS[2] },
        ], ls);
        avatarOverlay.installRendererAvatarOverlay({ document, window, getLocale: () => "en-US" });
      };`,
    resolveDir: repoRoot,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
});
const bundle = outputFiles[0]?.text ?? "";

const WORKBENCH_HTML = `<!doctype html><html data-theme="light"><head><meta charset="utf-8" /><style>
  :root { --wb-bg-app: #f3f1ed; --wb-surface-primary: #faf9f6; --wb-surface-secondary: #f4f2ee; --wb-elevated: #ffffff; --wb-border-subtle: rgba(20,20,19,0.075); --wb-text-primary: #141413; --wb-text-secondary: #5c5a54; }
  html.dark, [data-theme="dark"] { --wb-bg-app: #111110; --wb-surface-primary: #191918; --wb-surface-secondary: #201f1d; --wb-elevated: #282725; --wb-border-subtle: rgba(255,255,255,0.08); --wb-text-primary: #f0eee9; --wb-text-secondary: #a3a098; }
  * { box-sizing: border-box; } body { margin: 0; background: var(--wb-bg-app); color: var(--wb-text-primary); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
  [data-app-shell-titlebar] { height: 48px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; } .workbench-body { flex: 1; min-height: 0; display: flex; padding: 0 10px 10px; gap: 8px; position: relative; }
  aside[data-app-shell-sidebar] { width: 240px; flex-shrink: 0; background: var(--wb-surface-secondary); border-radius: 14px; padding: 12px 10px; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--wb-border-subtle); }
  [data-app-action-sidebar-thread-row] { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; font-size: 12.5px; color: var(--wb-text-secondary); cursor: pointer; } [data-app-action-sidebar-thread-row][data-active="true"] { background: var(--wb-elevated); color: var(--wb-text-primary); font-weight: 500; }
  .PageSurface, .MainContentSurface { flex: 1; min-width: 0; background: var(--wb-surface-primary); border-radius: 16px; border: 1px solid var(--wb-border-subtle); display: flex; flex-direction: column; overflow: hidden; } .conversation-canvas { flex: 1; padding: 20px 28px; } .msg-card { padding: 14px 18px; border-radius: 12px; background: var(--wb-elevated); border: 1px solid var(--wb-border-subtle); font-size: 13.5px; }
</style></head><body><div class="Layout PageSurfaceLayout" data-app-shell-frame="true" data-app-shell-page-surface="true" style="display:flex;flex-direction:column;height:100vh;overflow:hidden;"><header data-app-shell-titlebar="true"><button type="button" id="sidebar-toggle-btn" aria-label="Toggle sidebar">☰</button><span>CodexHost Workbench</span></header><div class="workbench-body" data-app-shell-active-page="true"><aside data-app-shell-sidebar="true" role="navigation"><div id="sidebar-rows"></div></aside><main class="MainContentSurface" data-app-shell-main-surface="default"><div class="conversation-canvas"><div class="msg-card">PageSurface Active Session Strip</div></div></main></div></div><script>${bundle}</script></body></html>`;

const PET_HTML = `<!doctype html><html data-theme="light"><head><meta charset="utf-8" /></head><body style="margin:0;padding:20px;background:#f3f1ed;color:#141413;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;display:flex;justify-content:center;"><div id="pet-root"><div role="log" style="width:260px;height:64px;margin-bottom:10px;padding:10px 12px;border-radius:12px;">Streaming checks...</div><div data-avatar-overlay-size="notification-tray" style="height:92px;width:344px;"><div data-avatar-overlay-size="notification-tray-list" style="height:92px;max-height:208px;"><form data-avatar-overlay-native-surface-id="composer" data-avatar-overlay-hit-region="notification-composer" style="margin-bottom:8px;"><input type="text" placeholder="Dispatch task to agent..." style="width:100%;height:34px;border-radius:10px;" /></form><div data-avatar-overlay-size="notification-stack-visible-layout" style="height:92px;"><div data-avatar-overlay-size="notification-stack-backing-layout" style="height:92px;"></div></div></div></div></div><script>${bundle}</script></body></html>`;

type WinHarness = Window & {
  mountTestWorkbench: (s?: unknown) => void;
  mountPetWorkbench: () => void;
  __topTabsHandle?: { refresh: () => void };
};

test.describe("Stage 2 Frontend UX — PageSurface Session Strip & Pet Closed Loop", () => {
  test("PageSurface mount, 6-session compact-icons density, zero-reflow hover, and screenshots", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.route("http://codexhost-top-tabs.test/**", (r) =>
      r.fulfill({ contentType: "text/html", body: WORKBENCH_HTML }),
    );
    await page.goto("http://codexhost-top-tabs.test/index.html");
    await page.evaluate(() => (window as unknown as WinHarness).mountTestWorkbench());

    expect(await page.locator("[data-app-shell-titlebar] [data-codexhost-top-tabs]").count()).toBe(
      0,
    );
    expect(
      await page.locator('[data-app-shell-frame="true"] > [data-codexhost-top-tabs]').count(),
    ).toBe(0);
    expect((await page.locator("[data-app-shell-titlebar]").boundingBox())?.y).toBe(0);
    await expect(
      page.locator('main[data-app-shell-main-surface="default"] > [data-codexhost-top-tabs]'),
    ).toBeVisible();
    await expect(page.locator("[data-codexhost-top-tab-close]")).toHaveCount(0);
    await expect(page.locator("[data-codexhost-top-tabs-more]")).toHaveCount(0);
    await expect(page.locator(".session-slot")).toHaveCount(6);

    for (const width of [780, 800, 954]) {
      await page.setViewportSize({ width, height: 820 });
      await page.evaluate(() => (window as unknown as WinHarness).__topTabsHandle?.refresh());
      await expect(page.locator(".session-pill-track")).toHaveAttribute(
        "data-density",
        "compact-icons",
      );
      const activeBox = await page.locator('.session-slot[data-selected="true"]').boundingBox();
      expect(activeBox?.width ?? 0).toBeLessThanOrEqual(220);
      expect(activeBox?.width ?? 0).toBeGreaterThanOrEqual(130);
      const bgSlots = page.locator('.session-slot:not([data-selected="true"])');
      expect((await bgSlots.first().boundingBox())?.width ?? 0).toBe(42);
    }

    await page.setViewportSize({ width: 800, height: 820 });
    await page.evaluate(() => (window as unknown as WinHarness).__topTabsHandle?.refresh());
    await page.screenshot({ path: path.join(shotDir, "main-window-light.png") });

    const offsetsBefore = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".session-slot"), (el) => el.offsetLeft),
    );
    const secondSlot = page.locator(".session-slot").nth(1);
    await secondSlot.hover();
    await expect(secondSlot).toHaveAttribute("data-floating", "true");

    const hoverState = await page.evaluate(() => {
      const slotEls = Array.from(document.querySelectorAll<HTMLElement>(".session-slot"));
      const btn = slotEls[1]?.querySelector<HTMLElement>(".session-pill-btn");
      const titleEl = btn?.querySelector<HTMLElement>(".session-title");
      const st = btn?.querySelector<HTMLElement>(".s-state-label");
      return {
        offsetsDuring: slotEls.map((el) => el.offsetLeft),
        computedPos: btn ? window.getComputedStyle(btn).position : "",
        computedBg: btn ? window.getComputedStyle(btn).backgroundColor : "",
        titleTruncated: titleEl ? titleEl.scrollWidth > titleEl.clientWidth : true,
        hostBadgeText: btn?.querySelector<HTMLElement>(".s-host-badge")?.textContent ?? null,
        stateLabelDisplay: st ? window.getComputedStyle(st).display : "none",
      };
    });
    expect(hoverState.computedPos).toBe("absolute");
    expect(hoverState.computedBg).toBe("rgb(255, 255, 255)");
    expect(hoverState.titleTruncated).toBe(false);
    expect(hoverState.hostBadgeText).toBe("MacPro");
    expect(hoverState.stateLabelDisplay).not.toBe("none");
    expect(hoverState.offsetsDuring).toEqual(offsetsBefore);

    await page.screenshot({ path: path.join(shotDir, "main-window-compact-hover-light.png") });
    const lastSlot = page.locator(".session-slot").nth(5);
    await lastSlot.hover();
    await expect(lastSlot).toHaveAttribute("data-align-right", "true");

    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await page.mouse.move(10, 10);
    await page.screenshot({ path: path.join(shotDir, "main-window-dark.png") });
  });

  test("reading lease (viewedLeaseKey), acknowledgedFailedKeys, and 0px height collapse", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 760 });
    await page.route("http://codexhost-top-tabs.test/**", (r) =>
      r.fulfill({ contentType: "text/html", body: WORKBENCH_HTML }),
    );
    await page.goto("http://codexhost-top-tabs.test/index.html");
    await page.evaluate(
      (s) => (window as unknown as WinHarness).mountTestWorkbench(s),
      [
        ["local", "t-unread", "Unread Task", "unread", "claude-code", false],
        ["local", "t-fail", "Failed Task", "failed", "gemini", false],
      ],
    );

    await expect(page.locator(".session-slot")).toHaveCount(2);
    await page.locator('[data-codexhost-top-tab="local:t-unread"]').click();
    await page.evaluate(() => {
      document.getElementById("row-t-unread")?.setAttribute("data-thread-status", "idle");
      (window as unknown as WinHarness).__topTabsHandle?.refresh();
    });
    const unreadSlot = page.locator('[data-session-slot="local:t-unread"]');
    await expect(unreadSlot).toHaveAttribute("data-selected", "true");
    await expect(page.locator(".session-slot")).toHaveCount(2);

    await page.locator('[data-codexhost-top-tab="local:t-fail"]').click();
    await expect(page.locator(".session-slot")).toHaveCount(1);
    const failSlot = page.locator('[data-session-slot="local:t-fail"]');
    await expect(failSlot).toHaveAttribute("data-selected", "true");

    await page.evaluate(() => {
      document.getElementById("row-t-fail")?.removeAttribute("data-active");
      document.getElementById("row-t-unread")?.setAttribute("data-active", "true");
      (window as unknown as WinHarness).__topTabsHandle?.refresh();
    });
    const strip = page.locator("[data-codexhost-top-tabs]");
    await expect(strip).toHaveAttribute("data-hidden", "true");
    expect((await strip.boundingBox())?.height ?? 0).toBe(0);
  });

  test("Main Window <-> Pet Window closed loop (remote threads, icons, catalog, click-to-open)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 440, height: 760 });
    await page.route("http://codexhost-pet-loop.test/**", (r) =>
      r.fulfill({ contentType: "text/html", body: PET_HTML }),
    );
    await page.goto("http://codexhost-pet-loop.test/index.html?initialRoute=%2Favatar-overlay");
    await page.evaluate(() => (window as unknown as WinHarness).mountPetWorkbench());

    const remoteCards = page.locator("[data-codexhost-pets-remote-item]");
    await expect(remoteCards).toHaveCount(3);
    await expect(remoteCards.nth(1)).toContainText("[MacPro]");
    await expect(remoteCards.nth(2)).toContainText("[NAS]");
    const remoteIcons = page.locator("[data-codexhost-pets-remote-item] svg");
    expect(await remoteIcons.count()).toBeGreaterThanOrEqual(3);

    const agentPill = page.locator("[data-codexhost-pets-agent-pill]");
    await agentPill.click();
    await expect(page.locator("[data-codexhost-pets-agent-menu] button")).toHaveCount(4);
    const petMenuLayout = await page.evaluate(() => {
      const pill = document.querySelector<HTMLElement>("[data-codexhost-pets-agent-pill]");
      const menu = document.querySelector<HTMLElement>("[data-codexhost-pets-agent-menu]");
      const firstCard = document.querySelector<HTMLElement>("[data-codexhost-pets-remote-item]");
      const mRect = menu?.getBoundingClientRect();
      const cRect = firstCard?.getBoundingClientRect();
      return {
        pillColor: pill ? window.getComputedStyle(pill).color : "",
        menuBottom: mRect?.bottom ?? 0,
        firstCardTop: cRect?.top ?? 0,
      };
    });
    expect(petMenuLayout.pillColor).toBe("rgb(243, 244, 246)");
    expect(petMenuLayout.menuBottom).toBeLessThanOrEqual(petMenuLayout.firstCardTop);
    await page.screenshot({ path: path.join(shotDir, "pet-window-light.png") });

    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.setAttribute("data-theme", "dark");
      document.body.style.background = "#111110";
      document.body.style.color = "#f0eee9";
    });
    await page.screenshot({ path: path.join(shotDir, "pet-window-dark.png") });

    await agentPill.click();
    await remoteCards.nth(1).dispatchEvent("click");
    const openReq = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem("codexhost.pets-open-thread-request.v1") ?? "null"),
    );
    expect(openReq).toMatchObject({ hostId: "macpro.local", threadId: "thr-macpro-wait" });
  });
});
