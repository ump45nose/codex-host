import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { devices } from "../src/device.mjs";

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
    expect(result.stdout).toContain("codexhost-bot devices [--query TEXT] [--harness ID]");
    expect(result.stdout).toContain("[--model ID] [--thinking ID]");

    const fakeCli = path.join(directory, "fake-codexhost.mjs");
    await writeFile(
      fakeCli,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "client" && args[1] === "list") process.stdout.write(JSON.stringify({ clients: [] }));
else if (args[0] === "client" && args[1] === "add") process.stdout.write(JSON.stringify({ token: "tok" }));
else if (args[0] === "host" && args[1] === "info") process.stdout.write(JSON.stringify({ defaultWorkspace: "/ws" }));
else if (args[0] === "harness" && args[1] === "list") process.stdout.write(JSON.stringify({ harnesses: ["codex", "antigravity"] }));
else if (args[0] === "harness" && args[1] === "inspect") process.stdout.write(JSON.stringify({ harnessId: args[2], status: "ready", defaultModel: "gemini-4-argon", models: [{ id: "gemini-4-argon", label: "Gemini 4 Argon", thinking: ["low", "medium", "high"] }] }));
else if (args[0] === "project" && args[1] === "list") process.stdout.write(JSON.stringify({ projects: [], observedAt: "now", unavailableRoots: [], truncated: false, total: 0, nextOffset: null }));
else process.exit(1);
`,
      { mode: 0o755 },
    );
    const config = {
      privateDir: path.join(directory, "private"),
      devices: [
        {
          id: "local-dev",
          transport: "local",
          cli: fakeCli,
          node: process.execPath,
          dataDir: path.join(directory, "data"),
          privateDir: path.join(directory, "dev-private"),
        },
      ],
    };
    const withoutInspect = await devices(config, "account");
    expect(withoutInspect.devices[0].harnessInspection).toBeUndefined();
    const withInspect = await devices(config, "account", { harness: "antigravity" });
    expect(withInspect.devices[0].harnessInspection).toMatchObject({
      harnessId: "antigravity",
      status: "ready",
      defaultModel: "gemini-4-argon",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
