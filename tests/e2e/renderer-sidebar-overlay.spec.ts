import { chromium, expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const browserExecutable =
  process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH ??
  (fs.existsSync(chromium.executablePath())
    ? undefined
    : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((candidate) =>
        fs.existsSync(candidate),
      ));
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import {
        installRendererSidebarOverlay,
        readSidebarAutoCollapsePreference,
        setSidebarAutoCollapsePreference,
      } from "./packages/renderer-extension/src/renderer-sidebar-overlay.ts";
      import { createAppearanceSettingsPage } from "./packages/renderer-extension/src/settings/appearance-page.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";

      window.installOverlay = () => {
        const NativeObserver = window.MutationObserver;
        let deliveries = 0, limitReached = false, locale = "en";
        // Bound a regression without changing native microtask delivery below the limit.
        window.MutationObserver = class extends NativeObserver {
          constructor(callback) {
            super((records, observer) => {
              deliveries++;
              if (deliveries > 100) {
                limitReached = true;
                observer.disconnect();
                return;
              }
              callback(records, observer);
            });
          }
        };
        try {
          const control = installRendererSidebarOverlay({ getLocale: () => locale });
          window.overlayFixture = {
            control,
            readPreference: () => readSidebarAutoCollapsePreference(window),
            setPreference: (enabled) => setSidebarAutoCollapsePreference(window, enabled),
            stats: () => ({ deliveries, limitReached }),
            setLocale: (value) => { locale = value; control.refresh(); },
            mountAppearanceSettings: (targetLocale) => {
              const host = document.querySelector("#settings-host");
              if (!host) return null;
              host.replaceChildren();
              const messages = rendererSettingsMessages(targetLocale);
              const page = createAppearanceSettingsPage(messages);
              const controller = new AbortController();
              return page.mount({
                content: host,
                signal: controller.signal,
                runLatest: () => {},
              });
            },
          };
        } finally {
          window.MutationObserver = NativeObserver;
        }
      };
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
if (!bundle) throw new Error("Sidebar overlay fixture bundle is missing");

const pinSelector = "[data-codexhost-sidebar-pin-button]";

async function setup(page: Page, mode: string | null, width: number, threadCount: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.route("http://codexhost-sidebar.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <div data-app-shell-frame data-app-shell-sidebar-open="true">
          <button type="button" data-app-shell-sidebar-trigger>Toggle sidebar</button>
          <aside class="app-shell-left-panel">
            <div id="app-shell-sidebar" data-sidebar-navigation-root>
              <div class="gap-toolbar-action"></div>
              <div id="threads"></div>
            </div>
          </aside>
          <aside data-testid="app-shell-floating-left-panel">Floating drawer</aside>
        </div>
        <div id="settings-host"></div>`,
    }),
  );
  await page.goto("http://codexhost-sidebar.test/");
  await page.evaluate(
    ({ mode, threadCount }) => {
      localStorage.clear();
      if (mode !== null) {
        localStorage.setItem("codexhost.sidebar-overlay-mode.v1", mode);
      }
      const frame = document.querySelector("[data-app-shell-frame]");
      const trigger = document.querySelector("[data-app-shell-sidebar-trigger]");
      let triggerClicks = 0;
      trigger?.addEventListener("click", () => {
        triggerClicks += 1;
        const open = frame?.getAttribute("data-app-shell-sidebar-open") === "true";
        frame?.setAttribute("data-app-shell-sidebar-open", open ? "false" : "true");
      });
      Reflect.set(window, "getTriggerClicks", () => triggerClicks);

      const threads = document.querySelector("#threads");
      for (let index = 0; index < threadCount; index++) {
        const row = document.createElement("div");
        row.setAttribute("data-app-action-sidebar-thread-row", "");
        row.textContent = `Synthetic thread ${index}`;
        threads?.appendChild(row);
      }
    },
    { mode, threadCount },
  );
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => Reflect.get(window, "installOverlay")());
}

async function settle(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ deliveries: number; limitReached: boolean }>((resolve) => {
        setTimeout(() => resolve(Reflect.get(window, "overlayFixture").stats()), 0);
      }),
  );
}

for (const [mode, width, threadCount, expectedAutoCollapse, expectedSidebarOpen] of [
  ["docked", 1140, 0, false, "true"],
  ["docked", 954, 0, false, "true"],
  ["overlay", 954, 2000, true, "false"],
  ["auto", 1140, 2000, true, "true"],
  ["auto", 954, 0, true, "false"],
  [null, 954, 0, true, "false"],
] as const) {
  test(`migrates legacy mode ${String(mode)} at ${width}px with ${threadCount} threads without observer loop or pin button`, async ({
    page,
  }) => {
    await setup(page, mode, width, threadCount);
    const initial = await settle(page);
    expect(initial.deliveries).toBeLessThanOrEqual(2);
    expect(initial.limitReached).toBe(false);

    expect(await page.evaluate(() => Reflect.get(window, "overlayFixture").readPreference())).toBe(
      expectedAutoCollapse,
    );
    await expect(page.locator("[data-app-shell-frame]")).toHaveAttribute(
      "data-app-shell-sidebar-open",
      expectedSidebarOpen,
    );
    await expect(page.locator(pinSelector)).toHaveCount(0);
    await expect(page.locator('[data-testid="app-shell-floating-left-panel"]')).toBeVisible();

    await page.evaluate(() => {
      const fixture = Reflect.get(window, "overlayFixture");
      fixture.control.refresh();
      fixture.control.refresh();
      document.body.appendChild(document.createElement("div"));
    });
    const afterMutation = await settle(page);
    expect(afterMutation.limitReached).toBe(false);
    expect(afterMutation.deliveries - initial.deliveries).toBeLessThanOrEqual(1);
    await expect(page.locator(pinSelector)).toHaveCount(0);
  });
}

test("collapses once across 1140px -> 954px threshold and keeps manual narrow expansion docked", async ({
  page,
}) => {
  await setup(page, null, 1140, 4);
  await settle(page);

  const frame = page.locator("[data-app-shell-frame]");
  const trigger = page.locator("[data-app-shell-sidebar-trigger]");

  await expect(frame).toHaveAttribute("data-app-shell-sidebar-open", "true");
  expect(await page.evaluate(() => Reflect.get(window, "getTriggerClicks")())).toBe(0);

  // Crossing >= 1080px -> < 1080px (1140px -> 954px) triggers one native collapse.
  await page.setViewportSize({ width: 954, height: 900 });
  await expect(frame).toHaveAttribute("data-app-shell-sidebar-open", "false");
  expect(await page.evaluate(() => Reflect.get(window, "getTriggerClicks")())).toBe(1);

  // User manually expands sidebar in narrow viewport (954px): remains docked across pointerout and narrow resizes.
  await trigger.click();
  await expect(frame).toHaveAttribute("data-app-shell-sidebar-open", "true");
  expect(await page.evaluate(() => Reflect.get(window, "getTriggerClicks")())).toBe(2);

  await page.locator("#app-shell-sidebar").dispatchEvent("pointerout");
  await page.waitForTimeout(240);
  await page.setViewportSize({ width: 800, height: 900 });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(800);
  await expect(frame).toHaveAttribute("data-app-shell-sidebar-open", "true");
  expect(await page.evaluate(() => Reflect.get(window, "getTriggerClicks")())).toBe(2);

  // Re-crossing >= 1080px -> < 1080px triggers one native collapse again.
  await page.setViewportSize({ width: 1140, height: 900 });
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, "overlayFixture").control.isNarrowViewport()),
    )
    .toBe(false);
  await expect(frame).toHaveAttribute("data-app-shell-sidebar-open", "true");
  await page.setViewportSize({ width: 954, height: 900 });
  await expect(frame).toHaveAttribute("data-app-shell-sidebar-open", "false");
  expect(await page.evaluate(() => Reflect.get(window, "getTriggerClicks")())).toBe(3);

  await page.evaluate(() => Reflect.get(window, "overlayFixture").control.dispose());
  const disposed = await settle(page);
  await page.evaluate(() => document.body.appendChild(document.createElement("div")));
  expect(await settle(page)).toEqual(disposed);
});

test("renders Appearance settings boolean switch and matching zh-CN / en copy", async ({
  page,
}) => {
  await setup(page, "docked", 1140, 0);
  await page.evaluate(() => Reflect.get(window, "overlayFixture").mountAppearanceSettings("zh-CN"));

  const zhSwitch = page.getByRole("switch", { name: "窄屏自动收起左边栏" });
  await expect(zhSwitch).toBeVisible();
  await expect(zhSwitch).not.toBeChecked();
  await expect(page.locator("#settings-host")).toContainText("1080px");
  await expect(page.locator("#settings-host")).toContainText("57px");
  await expect(page.getByRole("switch", { name: "顶部活动会话条" })).toBeVisible();
  await expect(page.locator("#settings-host")).toContainText("未读");

  await zhSwitch.click();
  await expect(zhSwitch).toBeChecked();
  expect(await page.evaluate(() => Reflect.get(window, "overlayFixture").readPreference())).toBe(
    true,
  );

  // Verify crossing 1140px -> 954px now collapses since switch was turned on.
  await page.setViewportSize({ width: 954, height: 900 });
  await expect(page.locator("[data-app-shell-frame]")).toHaveAttribute(
    "data-app-shell-sidebar-open",
    "false",
  );

  await page.evaluate(() => Reflect.get(window, "overlayFixture").mountAppearanceSettings("en"));
  const enSwitch = page.getByRole("switch", {
    name: "Auto-collapse left sidebar on narrow screens",
  });
  await expect(enSwitch).toBeVisible();
  await expect(enSwitch).toBeChecked();
  await expect(page.getByRole("switch", { name: "Top active session strip" })).toBeVisible();
  await expect(page.locator("#settings-host")).toContainText("unread");
});
