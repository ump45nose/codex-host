import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")("runs through the Unix npm command symlink", async () => {
  const parent = path.resolve("outputs/.bot-integration-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "cli-"));
  try {
    const command = path.join(directory, "codexhost-bot");
    await symlink(fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), command);
    const result = spawnSync(process.execPath, [command, "--help"], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("codexhost-bot devices");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
