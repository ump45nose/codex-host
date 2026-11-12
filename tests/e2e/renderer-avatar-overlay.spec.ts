import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const browserExecutable =
  process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH ??
  (fs.existsSync(chromium.executablePath())
    ? undefined
    : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((c) =>
        fs.existsSync(c),
      ));
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { encodeHarnessPluginRoute, harnessIdSchema } from "./packages/shared-contracts/src/index.ts";
      import * as overlay from "./packages/renderer-extension/src/renderer-avatar-overlay.ts";
      window.avatarOverlayTestHarness = { encodeHarnessPluginRoute, harnessIdSchema, ...overlay };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
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
if (!bundle) throw new Error("Avatar overlay E2E bundle is missing");

interface AvatarOverlayTestHarness {
  readonly AVATAR_OVERLAY_AGENT_MENU_ATTR: string;
  readonly AVATAR_OVERLAY_AGENT_PILL_ATTR: string;
  readonly AVATAR_OVERLAY_REMOTE_ITEM_ATTR: string;
  readonly AVATAR_OVERLAY_REMOTE_LIST_ATTR: string;
  encodeHarnessPluginRoute(route: { harnessId: string }): string;
  installRendererAvatarOverlay(options: { document: Document; window: Window }): void;
  readPetsOpenThreadRequest(storage: Storage): { hostId: string; threadId: string } | null;
  writePetsHarnessCatalog(catalog: unknown, storage: Storage): void;
  writePetsRemoteThreads(threads: unknown, storage: Storage): void;
}

const renderPetHtml = (
  nativeStackItem = "",
) => `<!doctype html><html><head><meta charset="utf-8" /></head>
<body style="margin:0; padding:16px; background:transparent;"><div id="pet-root">
  <div role="log" id="left-preview-bubble" style="width:260px; height:80px;">Left preview bubble transcript</div>
  <div data-avatar-overlay-size="notification-tray" style="height:92px; width:344px;">
    <div data-avatar-overlay-size="notification-tray-list" style="height:92px; max-height:208px;">
      <form data-avatar-overlay-native-surface-id="composer" data-avatar-overlay-hit-region="notification-composer"><input type="text" placeholder="Ask" /></form>
      <div data-avatar-overlay-size="notification-stack-visible-layout" style="height:92px;">
        <div data-avatar-overlay-size="notification-stack-backing-layout" style="height:92px;">${nativeStackItem}</div>
      </div>
    </div>
  </div>
</div><script>${bundle}</script></body></html>`;

test.describe("Renderer Avatar Overlay (Pet) E2E", () => {
  test("expands notification-tray stack to min(520px, 60vh) with internal scroll and keeps left preview bubble resize === none", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.route("http://codexhost-avatar-overlay.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: renderPetHtml(
          `<div data-avatar-overlay-activity-stack-item="local:local:thr-native-1" inert aria-hidden="true" style="position:absolute; top:0;"><div class="Material-oi9n4Q activityPill-s8lFCN" data-avatar-overlay-native-surface-id="activity-local:local:thr-native-1"><span class="truncate">Native External Active Session</span></div></div>`,
        ),
      }),
    );
    await page.goto(
      "http://codexhost-avatar-overlay.test/index.html?initialRoute=%2Favatar-overlay",
    );

    const metrics900 = await page.evaluate(() => {
      const h = (window as unknown as { avatarOverlayTestHarness: AvatarOverlayTestHarness })
        .avatarOverlayTestHarness;
      h.writePetsHarnessCatalog(
        {
          enabledAgents: ["codex", "claude-code", "hermes"],
          plugins: [
            {
              id: "claude-code",
              name: "Claude Code",
              iconStyle: {
                vector: {
                  color: "#D97757",
                  viewBox: "0 0 24 24",
                  paths: [{ d: "M12 2L15 9H9L12 2Z" }],
                },
              },
            },
            { id: "hermes", name: "Hermes" },
          ],
        },
        window.localStorage,
      );
      const items = [
        {
          hostId: "local",
          threadId: "thr-native-1",
          title: "Native External Active Session",
          status: "running",
          agent: "claude-code",
        },
        ...Array.from({ length: 14 }, (_, idx) => ({
          hostId: idx % 2 === 0 ? "local" : "ssh-macpro",
          hostLabel: idx % 2 === 0 ? undefined : "MacPro",
          threadId: `thr-extra-${idx + 1}`,
          title: `Active External Session #${idx + 1} With Long Description`,
          status: idx % 3 === 0 ? "waiting" : idx % 3 === 1 ? "running" : "unread",
          agent: idx % 2 === 0 ? "claude-code" : "hermes",
        })),
        {
          hostId: "local",
          threadId: "thr-idle-hidden",
          title: "Idle Session",
          status: "idle",
          agent: "claude-code",
        },
      ];
      window.localStorage.setItem("codexhost.pets-remote-threads.v1", JSON.stringify(items));
      h.installRendererAvatarOverlay({ document, window });

      const preview =
        document.getElementById("left-preview-bubble") ?? document.createElement("div");
      const backing =
        document.querySelector<HTMLElement>(
          '[data-avatar-overlay-size="notification-stack-backing-layout"]',
        ) ?? document.createElement("div");
      const remoteList =
        document.querySelector<HTMLElement>(`[${h.AVATAR_OVERLAY_REMOTE_LIST_ATTR}]`) ??
        document.createElement("div");
      const scrollTarget = remoteList.scrollHeight > remoteList.clientHeight ? remoteList : backing;
      scrollTarget.scrollTop = 120;
      return {
        previewResize: window.getComputedStyle(preview).resize,
        previewHasExpandAttr: preview.hasAttribute("data-codexhost-pets-preview-expanded"),
        backingHeight: Math.round(backing.getBoundingClientRect().height),
        scrollHeight: scrollTarget.scrollHeight,
        clientHeight: scrollTarget.clientHeight,
        scrollTop: scrollTarget.scrollTop,
        appendedCount: remoteList.querySelectorAll(`[${h.AVATAR_OVERLAY_REMOTE_ITEM_ATTR}]`).length,
        nativeDuplicates: remoteList.querySelectorAll(
          '[data-codexhost-pets-remote-item="local:thr-native-1"]',
        ).length,
        idleCount: remoteList.querySelectorAll(
          '[data-codexhost-pets-remote-item="local:thr-idle-hidden"]',
        ).length,
      };
    });

    expect(metrics900.previewResize).toBe("none");
    expect(metrics900.previewHasExpandAttr).toBe(false);
    expect(metrics900.backingHeight).toBeGreaterThan(208);
    expect(metrics900.backingHeight).toBeLessThanOrEqual(520);
    expect(metrics900.scrollHeight).toBeGreaterThan(metrics900.clientHeight);
    expect(metrics900.scrollTop).toBeGreaterThan(0);
    expect(metrics900.appendedCount).toBe(14);
    expect(metrics900.nativeDuplicates).toBe(0);
    expect(metrics900.idleCount).toBe(0);

    await page.setViewportSize({ width: 420, height: 700 });
    const backingHeight700 = await page.evaluate(() =>
      Math.round(
        document
          .querySelector<HTMLElement>(
            '[data-avatar-overlay-size="notification-stack-backing-layout"]',
          )
          ?.getBoundingClientRect().height ?? 0,
      ),
    );
    expect(backingHeight700).toBeGreaterThan(208);
    expect(backingHeight700).toBeLessThanOrEqual(420);
  });

  test("computes valid native hit-region rects for pills and Quick Chat Agent menu without document.body escaped layers", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.route("http://codexhost-avatar-overlay.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: renderPetHtml() }),
    );
    await page.goto(
      "http://codexhost-avatar-overlay.test/index.html?initialRoute=%2Favatar-overlay",
    );

    const hitResult = await page.evaluate(() => {
      const h = (window as unknown as { avatarOverlayTestHarness: AvatarOverlayTestHarness })
        .avatarOverlayTestHarness;
      const isHitRegionVisible = (el: HTMLElement): boolean => {
        if (el.closest("[inert]") !== null) return false;
        const s = window.getComputedStyle(el);
        return (
          s.display !== "none" &&
          s.visibility !== "hidden" &&
          s.visibility !== "collapse" &&
          s.pointerEvents !== "none"
        );
      };
      const computeHitRegionRect = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        let [left, top, right, bottom] = [
          Math.max(0, r.left),
          Math.max(0, r.top),
          Math.min(window.innerWidth, r.right),
          Math.min(window.innerHeight, r.bottom),
        ];
        for (let a = el.parentElement; a; a = a.parentElement) {
          const s = window.getComputedStyle(a);
          const ar = a.getBoundingClientRect();
          const [sx, sy] = [
            a.offsetWidth ? ar.width / a.offsetWidth : 1,
            a.offsetHeight ? ar.height / a.offsetHeight : 1,
          ];
          const [al, at] = [ar.left + a.clientLeft * sx, ar.top + a.clientTop * sy];
          if (/auto|scroll|hidden|clip/.test(s.overflowX || s.overflow)) {
            left = Math.max(left, al);
            right = Math.min(right, al + a.clientWidth * sx);
          }
          if (/auto|scroll|hidden|clip/.test(s.overflowY || s.overflow)) {
            top = Math.max(top, at);
            bottom = Math.min(bottom, at + a.clientHeight * sy);
          }
        }
        return right <= left || bottom <= top
          ? null
          : {
              left: Math.floor(left),
              top: Math.floor(top),
              width: Math.ceil(right) - Math.floor(left),
              height: Math.ceil(bottom) - Math.floor(top),
            };
      };

      h.writePetsHarnessCatalog(
        {
          enabledAgents: ["codex", "claude-code", "hermes"],
          plugins: [
            {
              id: "claude-code",
              name: "Claude Code",
              iconStyle: {
                vector: {
                  color: "#D97757",
                  viewBox: "0 0 24 24",
                  paths: [{ d: "M12 2L15 9H9L12 2Z" }],
                },
              },
            },
            { id: "hermes", name: "Hermes" },
          ],
        },
        window.localStorage,
      );
      h.writePetsRemoteThreads(
        [
          {
            hostId: "local",
            threadId: "thr-local-1",
            title: "Local External Claude Session",
            status: "running",
            agent: "claude-code",
          },
          {
            hostId: "ssh-macpro",
            hostLabel: "MacPro",
            threadId: "thr-remote-2",
            title: "Remote SSH Hermes Session",
            status: "waiting",
            agent: "hermes",
          },
        ],
        window.localStorage,
      );
      h.installRendererAvatarOverlay({ document, window });

      document.querySelector<HTMLElement>(`[${h.AVATAR_OVERLAY_AGENT_PILL_ATTR}]`)?.click();
      const agentMenu =
        document.querySelector<HTMLElement>(`[${h.AVATAR_OVERLAY_AGENT_MENU_ATTR}]`) ??
        document.createElement("div");
      const activityPills = Array.from(
        document.querySelectorAll<HTMLElement>(`[${h.AVATAR_OVERLAY_REMOTE_ITEM_ATTR}]`),
      );
      const [menuVisible, menuRect] = [
        isHitRegionVisible(agentMenu),
        computeHitRegionRect(agentMenu),
      ];
      const pillRects = activityPills.map((p) => ({
        visible: isHitRegionVisible(p),
        rect: computeHitRegionRect(p),
        hitRegionAttr: p.getAttribute("data-avatar-overlay-hit-region"),
      }));
      const bodyEscapedCount = Array.from(document.body.children).filter(
        (c) =>
          c.hasAttribute(h.AVATAR_OVERLAY_AGENT_MENU_ATTR) ||
          c.hasAttribute(h.AVATAR_OVERLAY_REMOTE_LIST_ATTR),
      ).length;

      agentMenu.querySelector<HTMLElement>('[data-agent-option="claude-code"]')?.click();
      const channel = new MessageChannel();
      const receivedPromise = new Promise<unknown[]>((resolve) => {
        channel.port2.onmessage = (ev) => resolve(ev.data as unknown[]);
      });
      channel.port1.postMessage([
        "push",
        [
          "pipeline",
          0,
          ["startConversation"],
          [
            {
              collaborationMode: { mode: "default", settings: { model: "gpt-5.3-codex" } },
              config: { model: "gpt-5.3-codex" },
            },
          ],
        ],
      ]);
      activityPills[0]?.click();
      const openReq = h.readPetsOpenThreadRequest(window.localStorage);

      return receivedPromise.then((frame) => {
        const inner = (frame[1] as unknown[])[3] as Array<{
          collaborationMode: { settings: { model: string } };
          config: { model: string };
        }>;
        return {
          menuVisible,
          menuRect,
          menuHitRegionAttr: agentMenu.getAttribute("data-avatar-overlay-hit-region"),
          pillRects,
          bodyEscapedCount,
          openReq,
          rewrittenInput: inner[0],
          expectedRoute: h.encodeHarnessPluginRoute({ harnessId: "claude-code" }),
        };
      });
    });

    expect(hitResult.bodyEscapedCount).toBe(0);
    expect(hitResult.menuVisible).toBe(true);
    expect(hitResult.menuHitRegionAttr).toBe("notification-composer");
    expect(hitResult.menuRect?.width ?? 0).toBeGreaterThan(150);
    expect(hitResult.menuRect?.height ?? 0).toBeGreaterThan(60);
    expect(hitResult.pillRects).toHaveLength(2);
    for (const pill of hitResult.pillRects) {
      expect(pill.visible).toBe(true);
      expect(pill.hitRegionAttr).toBe("activity-pill");
      expect(pill.rect?.width ?? 0).toBeGreaterThan(200);
      expect(pill.rect?.height ?? 0).toBeGreaterThan(36);
    }
    expect(hitResult.openReq).toMatchObject({ hostId: "local", threadId: "thr-local-1" });
    expect(hitResult.rewrittenInput?.collaborationMode.settings.model).toBe(
      hitResult.expectedRoute,
    );
    expect(hitResult.rewrittenInput?.config.model).toBe(hitResult.expectedRoute);
  });
});
