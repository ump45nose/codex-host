import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSidebarStashLegacyFile,
  sidebarStashLegacyFilePath,
} from "../src/sidebar-stash-legacy-file.js";

describe("readSidebarStashLegacyFile", () => {
  it("returns exists:false when missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-stash-"));
    const result = await readSidebarStashLegacyFile(home);
    expect(result.exists).toBe(false);
    expect(result.document).toBeNull();
    expect(result.error).toBeNull();
    expect(result.path).toBe(sidebarStashLegacyFilePath(home));
  });

  it("parses ~/.codex-stash/stash.json", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-stash-"));
    const dir = path.join(home, ".codex-stash");
    await mkdir(dir);
    const doc = {
      version: 1,
      updatedAt: "2026-10-16T05:48:13.668Z",
      items: {
        abcdef12: {
          title: "From disk",
          dueAt: null,
          stashedAt: "2026-10-15T01:54:52.800Z",
        },
      },
    };
    await writeFile(path.join(dir, "stash.json"), JSON.stringify(doc), "utf8");
    const result = await readSidebarStashLegacyFile(home);
    expect(result.exists).toBe(true);
    expect(result.error).toBeNull();
    expect(result.document).toEqual(doc);
  });
});
