// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as topTabs from "../src/renderer-top-tabs.js";

interface RowSpec {
  readonly id: string;
  readonly indicator?: string;
  readonly selected?: boolean;
  readonly hostId?: string;
  readonly title?: string;
}

/** Returns the element matching `selector`, failing the test when it is missing. */
function find(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

const handles: topTabs.RendererTopTabsHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  window.localStorage.clear();
});

/** Mirrors Codex Desktop's sidebar row attributes and trailing indicator markup. */
function rowHtml({ id, indicator, selected, hostId = "local", title = `Title ${id}` }: RowSpec) {
  const glyph =
    indicator === "working"
      ? '<span class="flex h-5"><span role="status"><div data-loading-indicator=""></div></span></span>'
      : indicator
        ? '<span class="flex h-5"><span class="rounded-full bg-info-solid"></span></span>'
        : "<span></span>";
  return `<div data-app-action-sidebar-thread-row="true" data-app-action-sidebar-thread-id="${hostId}:${id}" data-app-action-sidebar-thread-host-id="${hostId}" data-app-action-sidebar-thread-title="${title}"${indicator ? ` data-sidebar-indicator="${indicator}"` : ""}${selected ? ' data-app-action-sidebar-thread-selected="true"' : ""}><span data-hover-card-open-immediately="">${glyph}</span></div>`;
}

function setup(rows: RowSpec[], options: topTabs.InstallRendererTopTabsOptions = {}) {
  document.head.innerHTML = "";
  document.body.innerHTML = `<nav><div data-app-action-sidebar-scroll="">${rows.map(rowHtml).join("")}</div></nav><div data-app-shell-active-page="true"><main data-app-shell-main-surface="default"><div class="page"></div></main></div>`;
  const handle = topTabs.installRendererTopTabs({ document, window, ...options });
  handles.push(handle);
  const row = (id: string, hostId = "local") =>
    find(`[data-app-action-sidebar-thread-id="${hostId}:${id}"]`);
  const tabs = () =>
    [...document.querySelectorAll<HTMLElement>(`[${topTabs.TOP_TAB_ATTRIBUTE}]`)].map((tab) =>
      tab.getAttribute(topTabs.TOP_TAB_ATTRIBUTE),
    );
  const strip = () => document.querySelector<HTMLElement>(`[${topTabs.TOP_TABS_ROOT_ATTRIBUTE}]`);
  return { handle, row, tabs, strip };
}

/** Mutations are coalesced on a short timer. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("collectSidebarThreads", () => {
  it("reads status, title and selection from native sidebar attributes", () => {
    setup([
      { id: "a", indicator: "working", selected: true },
      { id: "b", indicator: "approval" },
      { id: "c", indicator: "input" },
      { id: "d", indicator: "error" },
      { id: "e", indicator: "unread" },
      { id: "f" },
    ]);
    const map = topTabs.collectSidebarThreads(document);
    expect([...map.values()].map((s) => [s.threadId, s.status, s.active, s.title])).toEqual([
      ["a", "running", true, "Title a"],
      ["b", "waiting", false, "Title b"],
      ["c", "waiting", false, "Title c"],
      ["d", "failed", false, "Title d"],
      ["e", "unread", false, "Title e"],
      ["f", "idle", false, "Title f"],
    ]);
  });

  it("skips codexhost mirror rows and unsent drafts", () => {
    setup([{ id: "a", indicator: "working" }]);
    const nav = find("[data-app-action-sidebar-scroll]");
    nav.insertAdjacentHTML(
      "beforeend",
      rowHtml({ id: "client-new-thread:x", indicator: "working" }),
    );
    nav.insertAdjacentHTML("beforeend", rowHtml({ id: "a", indicator: "working" }));
    nav.lastElementChild?.setAttribute("data-codexhost-sidebar-thread-mirror", "true");
    expect([...topTabs.collectSidebarThreads(document).keys()]).toEqual(["local:a"]);
  });
});

describe("installRendererTopTabs", () => {
  it("lists only sessions that need attention, inside the main surface", () => {
    const { tabs, strip } = setup([
      { id: "run", indicator: "working" },
      { id: "idle" },
      { id: "open", selected: true },
      { id: "done", indicator: "unread", hostId: "remote-ssh-discovered:mac-work" },
    ]);
    expect(strip()?.parentElement?.tagName).toBe("MAIN");
    expect(strip()?.parentElement?.firstElementChild).toBe(strip());
    expect(tabs()).toEqual(["local:run", "remote-ssh-discovered:mac-work:done"]);
  });

  it("clones the native indicator glyph and opens the thread through its native row", () => {
    const { row } = setup([{ id: "run", indicator: "working" }]);
    const tab = find(`[${topTabs.TOP_TAB_ATTRIBUTE}="local:run"]`);
    expect(
      tab.querySelector(".codexhost-session-tab-indicator [data-loading-indicator]"),
    ).not.toBeNull();
    const click = vi.fn();
    row("run").addEventListener("click", click);
    tab.click();
    expect(click).toHaveBeenCalledOnce();
  });

  it("keeps a thread opened from the strip until the user leaves it", async () => {
    const { row, tabs } = setup([{ id: "a", indicator: "unread", selected: true }, { id: "b" }]);
    row("a").removeAttribute("data-sidebar-indicator");
    await settle();
    expect(tabs()).toEqual(["local:a"]);
    row("a").removeAttribute("data-app-action-sidebar-thread-selected");
    row("b").setAttribute("data-app-action-sidebar-thread-selected", "true");
    await settle();
    expect(tabs()).toEqual([]);
  });

  it("acknowledges a failed thread once viewed and shows it again when it fails after running", async () => {
    const { row, tabs } = setup([
      { id: "a", indicator: "error" },
      { id: "b", selected: true },
    ]);
    expect(tabs()).toEqual(["local:a"]);
    row("b").removeAttribute("data-app-action-sidebar-thread-selected");
    row("a").setAttribute("data-app-action-sidebar-thread-selected", "true");
    await settle();
    row("a").removeAttribute("data-app-action-sidebar-thread-selected");
    row("b").setAttribute("data-app-action-sidebar-thread-selected", "true");
    await settle();
    expect(tabs()).toEqual([]);
    row("a").setAttribute("data-sidebar-indicator", "working");
    await settle();
    row("a").setAttribute("data-sidebar-indicator", "error");
    await settle();
    expect(tabs()).toEqual(["local:a"]);
  });

  it("hides when nothing needs attention or the preference is off", async () => {
    const { row, strip } = setup([{ id: "a", indicator: "working" }]);
    expect(strip()?.hidden).toBe(false);
    row("a").removeAttribute("data-sidebar-indicator");
    await settle();
    expect(strip()?.hidden).toBe(true);
    row("a").setAttribute("data-sidebar-indicator", "working");
    await settle();
    expect(strip()?.hidden).toBe(false);
    topTabs.writeTopTabsEnabledPreference(false, window);
    await settle();
    expect(strip()?.hidden).toBe(true);
  });

  it("groups child threads under their root and rolls up the most urgent status", () => {
    const { tabs } = setup([{ id: "root" }, { id: "child", indicator: "approval" }], {
      tree: { rootThread: (_host: string, id: string) => (id === "child" ? "root" : id) } as never,
    });
    expect(tabs()).toEqual(["local:root"]);
    const tab = document.querySelector(`[${topTabs.TOP_TAB_ATTRIBUTE}="local:root"]`);
    expect(tab?.getAttribute("data-status")).toBe("waiting");
  });

  it("reports changes on the first collection and whenever the session set changes", async () => {
    const onChange = vi.fn();
    const { row, handle } = setup([{ id: "a" }], { onChange });
    expect(onChange).toHaveBeenCalledTimes(1);
    row("a").setAttribute("data-app-action-sidebar-thread-title", "Renamed");
    await settle();
    expect(onChange).toHaveBeenCalledTimes(2);
    handle.refresh();
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("ignores transcript mutations outside the sidebar", async () => {
    const onChange = vi.fn();
    setup([{ id: "a", indicator: "working" }], { onChange });
    find(".page").append(document.createElement("p"));
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("mounts on the page on screen when Codex keeps hidden pages mounted", () => {
    setup([{ id: "a", indicator: "working" }]);
    find("[data-app-shell-active-page]").insertAdjacentHTML(
      "beforebegin",
      '<div data-app-shell-active-page="false"><main data-app-shell-main-surface="default"></main></div>',
    );
    handles[0]?.refresh();
    expect(
      document
        .querySelector(`[${topTabs.TOP_TABS_ROOT_ATTRIBUTE}]`)
        ?.closest("[data-app-shell-active-page]")
        ?.getAttribute("data-app-shell-active-page"),
    ).toBe("true");
  });

  it("marks remote tabs with their host's globe color from the sidebar project icon", () => {
    const { strip } = setup([{ id: "r", indicator: "working", hostId: "remote-ssh:mac" }]);
    const nav = find("[data-app-action-sidebar-scroll]");
    nav.insertAdjacentHTML(
      "beforeend",
      '<span data-sidebar-project-kind="remote"><svg style="--remote-host-globe-color: #ffc300"></svg></span>',
    );
    const svg = nav.querySelector("svg") as SVGElement;
    Object.defineProperty(svg, "__reactFiber$test", {
      value: {
        memoizedProps: { style: {} },
        return: { memoizedProps: { hostId: "remote-ssh:mac" } },
      },
    });
    handles[0]?.refresh();
    expect(strip()?.querySelector(".codexhost-session-tab-host path")?.getAttribute("fill")).toBe(
      "#ffc300",
    );
  });

  it("wraps into two rows of five and collapses the rest into a +N menu", async () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({
      id: `t${i}`,
      indicator: "working",
      selected: i === 12,
    }));
    const { tabs } = setup(rows);
    // Nine tabs and the "+N" cell fill the 5 × 2 grid; the open thread stays visible.
    expect(tabs()).toHaveLength(9);
    expect(tabs()[8]).toBe("local:t12");
    const more = find(`[${topTabs.TOP_TABS_MORE_ATTRIBUTE}]`);
    expect(more.textContent).toBe("+4");
    more.click();
    const menuItems = [
      ...document.querySelectorAll(`[${topTabs.TOP_TABS_MENU_ATTRIBUTE}] [role="menuitem"]`),
    ].map((item) => item.getAttribute(topTabs.TOP_TAB_ATTRIBUTE));
    expect(menuItems).toEqual(["local:t8", "local:t9", "local:t10", "local:t11"]);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.querySelector(`[${topTabs.TOP_TABS_MENU_ATTRIBUTE}]`)).toBeNull();

    topTabs.setTopTabsTwoRowsPreference(window, false);
    await settle();
    expect(tabs()).toHaveLength(4);
    expect(find(`[${topTabs.TOP_TABS_MORE_ATTRIBUTE}]`).textContent).toBe("+9");
  });
});

describe("resolveShortHostLabel", () => {
  it("shortens remote host ids and custom names", () => {
    expect(topTabs.resolveShortHostLabel("local")).toBeNull();
    expect(topTabs.resolveShortHostLabel("remote-ssh-discovered:mac-work")).toBe("mac-work");
    expect(topTabs.resolveShortHostLabel("h1", "yuwk@macpro.local:22")).toBe("MacPro");
    expect(topTabs.resolveShortHostLabel("h2", "192.168.1.20:22")).toBe("192.168.1.20");
  });
});
