import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererSidebarOverlay } from "./packages/renderer-extension/src/renderer-sidebar-overlay/index.ts";
      window.installOverlay = () => {
        const NativeObserver = window.MutationObserver;
        let deliveries = 0, limitReached = false, locale = "en-US";
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
            stats: () => ({ deliveries, limitReached }),
            setLocale: value => { locale = value; control.refresh(); },
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
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Sidebar overlay fixture bundle is missing");

const pinSelector = "[data-codexhost-sidebar-pin-button]";

async function setup(page: Page, mode: string, width: number, threadCount: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.route("http://codexhost-sidebar.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><div data-app-shell-frame data-app-shell-sidebar-open="true">
        <aside class="app-shell-left-panel"><div id="app-shell-sidebar" data-sidebar-navigation-root>
          <div class="gap-toolbar-action"></div><div id="threads"></div>
        </div></aside></div>`,
    }),
  );
  await page.goto("http://codexhost-sidebar.test/");
  await page.evaluate(
    ({ mode, threadCount }) => {
      localStorage.setItem("codexhost.sidebar-overlay-mode.v1", mode);
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
  // A task cannot run until the observer's microtask checkpoint has finished.
  return page.evaluate(
    () =>
      new Promise<{ deliveries: number; limitReached: boolean }>((resolve) => {
        setTimeout(() => resolve(Reflect.get(window, "overlayFixture").stats()), 0);
      }),
  );
}

for (const [mode, width, threadCount, pinned] of [
  ["docked", 1400, 0, true],
  ["overlay", 800, 2000, false],
  ["auto", 1400, 2000, true],
  ["auto", 800, 0, false],
] as const) {
  test(`settles native observer delivery in ${mode} at ${width}px with ${threadCount} threads`, async ({
    page,
  }) => {
    await setup(page, mode, width, threadCount);
    const initial = await settle(page);
    expect(initial.deliveries).toBeLessThanOrEqual(2);
    expect(initial.limitReached).toBe(false);
    await expect(page.locator(pinSelector)).toHaveAttribute("aria-pressed", String(pinned));
    const unchanged = await page.evaluate((selector) => {
      const icon = document.querySelector(`${selector} svg`);
      Reflect.set(window, "initialPinIcon", icon);
      const fixture = Reflect.get(window, "overlayFixture");
      fixture.control.refresh();
      fixture.control.refresh();
      const unrelated = document.createElement("div");
      document.body.appendChild(unrelated);
      return icon === document.querySelector(`${selector} svg`);
    }, pinSelector);
    expect(unchanged).toBe(true);
    const afterMutation = await settle(page);
    expect(afterMutation.limitReached).toBe(false);
    expect(afterMutation.deliveries - initial.deliveries).toBe(1);
    expect(
      await page.evaluate(
        (selector) =>
          Reflect.get(window, "initialPinIcon") === document.querySelector(`${selector} svg`),
        pinSelector,
      ),
    ).toBe(true);
  });
}

test("updates mode and locale, remounts the pin button and disposes without a loop", async ({
  page,
}) => {
  await setup(page, "docked", 1400, 0);
  await settle(page);
  const pin = page.locator(pinSelector);
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("html")).toHaveAttribute("data-codexhost-sidebar-overlay-open", "true");
  await page.evaluate(() => Reflect.get(window, "overlayFixture").setLocale("zh-CN"));
  await expect(pin).toHaveAttribute("aria-label", "固定展开侧边栏");
  await page.evaluate(() => {
    document.querySelector(".gap-toolbar-action")?.replaceWith(document.createElement("div"));
    const header = document.querySelector("[data-sidebar-navigation-root] > div");
    if (header) header.className = "gap-toolbar-action";
  });
  await expect(pin).toHaveCount(1);
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await expect(pin).toHaveAttribute("aria-label", "固定展开侧边栏");
  await page.evaluate(() => Reflect.get(window, "overlayFixture").control.setMode("docked"));
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  expect((await settle(page)).limitReached).toBe(false);
  await page.evaluate(() => Reflect.get(window, "overlayFixture").control.dispose());
  const disposed = await settle(page);
  await expect(pin).toHaveCount(0);
  await page.evaluate(() => document.body.appendChild(document.createElement("div")));
  expect(await settle(page)).toEqual(disposed);
});
