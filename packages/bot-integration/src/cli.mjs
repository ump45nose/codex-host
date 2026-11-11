#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { fail } from "./store.mjs";
import { grokAccount } from "./grok.mjs";
import { devices } from "./device.mjs";
import { ensureOrigin, originStatus, acknowledgeOrigin, clearOriginRequest } from "./origin.mjs";
import {
  startTask,
  readTask,
  changeTask,
  resolveEvent,
  exportTaskFile,
  delivery,
  replayTaskEvent,
} from "./task.mjs";

export const HELP = `codexhost-bot devices [--query TEXT] [--refresh true|false]
codexhost-bot origin ensure|status --bot ID
codexhost-bot origin ack --bot ID --nonce HEX
codexhost-bot origin cancel --bot ID --request-id ID
codexhost-bot task start --bot ID --device ID --task TEXT --request-id ID [--cwd PATH] [--harness ID] [--task-name TEXT]
codexhost-bot task read|cancel --bot ID --task-id ID
codexhost-bot task send --bot ID --task-id ID --message TEXT
codexhost-bot task resolve --bot ID --thread ID --event ID
codexhost-bot task export --bot ID --task-id ID --path FILE
codexhost-bot task delivery --bot ID --task-id ID --state sending|unknown|failed [--artifact-id ID] [--reason TEXT]
codexhost-bot task ack --bot ID --task-id ID --receipt NATIVE_RECEIPT [--artifact-id ID]
codexhost-bot task replay --bot ID --task-id ID

Set CODEXHOST_BOT_CONFIG to the installed private configuration. Output is JSON; credentials never appear.
Native Codex is the default; no model or thinking override is sent. A pending origin blocks task start.
`;

export async function run(arguments_, environment = process.env) {
  if (!arguments_.length || (arguments_.length === 1 && arguments_[0] === "--help"))
    return { help: HELP };
  const [group, second] = arguments_;
  const command = group === "devices" ? "devices" : second;
  const args = arguments_.slice(group === "devices" ? 1 : 2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name?.startsWith("--") || args[index + 1] === undefined || Object.hasOwn(options, name))
      fail("INVALID_ARGUMENT", "Use each --option with exactly one value");
    options[name] = args[index + 1];
  }
  const commands = {
    devices: ["--query", "--refresh"],
    "origin ensure": ["--bot", "--repair", "--request", "--request-id"],
    "origin cancel": ["--bot", "--request-id"],
    "origin status": ["--bot"],
    "origin ack": ["--bot", "--nonce"],
    "task start": [
      "--bot",
      "--device",
      "--cwd",
      "--task",
      "--request-id",
      "--harness",
      "--task-name",
    ],
    "task read": ["--bot", "--task-id"],
    "task cancel": ["--bot", "--task-id"],
    "task send": ["--bot", "--task-id", "--message"],
    "task resolve": ["--bot", "--thread", "--event"],
    "task export": ["--bot", "--task-id", "--path"],
    "task delivery": ["--bot", "--task-id", "--state", "--reason", "--artifact-id"],
    "task ack": ["--bot", "--task-id", "--receipt", "--artifact-id"],
    "task replay": ["--bot", "--task-id"],
  };
  const name = group === "devices" ? "devices" : `${group} ${command}`;
  if (!commands[name] || Object.keys(options).some((key) => !commands[name].includes(key)))
    fail("INVALID_ARGUMENT", "Unknown command or option; use --help");
  const config = await loadConfig(environment);
  const context = await grokAccount(config);
  const bot = options["--bot"],
    id = options["--task-id"];
  switch (name) {
    case "devices":
      if (options["--refresh"] !== undefined && !["true", "false"].includes(options["--refresh"]))
        fail("INVALID_ARGUMENT", "--refresh must be true or false");
      return devices(config, context.account, {
        query: options["--query"],
        refresh: options["--refresh"] === "true",
      });
    case "origin ensure":
      if (options["--repair"] !== undefined && options["--repair"] !== "true")
        fail("INVALID_ARGUMENT", "--repair must be true");
      return ensureOrigin(config, context, bot, {
        repair: options["--repair"] === "true",
        request: options["--request"],
        requestId: options["--request-id"],
      });
    case "origin cancel":
      return clearOriginRequest(config, context, bot, options["--request-id"]);
    case "origin status":
      return originStatus(config, context, bot);
    case "origin ack":
      return acknowledgeOrigin(config, context, bot, options["--nonce"]);
    case "task start":
      return startTask(config, context, bot, {
        device: options["--device"],
        cwd: options["--cwd"],
        task: options["--task"],
        requestId: options["--request-id"],
        harness: options["--harness"],
        taskName: options["--task-name"],
      });
    case "task read":
      return readTask(config, context, bot, id);
    case "task send":
      if (!options["--message"]?.trim()) fail("INVALID_ARGUMENT", "--message is required");
      return changeTask(config, context, bot, id, "send", options["--message"]);
    case "task cancel":
      return changeTask(config, context, bot, id, "cancel");
    case "task resolve":
      return resolveEvent(config, context, bot, options["--thread"], options["--event"]);
    case "task export":
      if (!options["--path"]) fail("INVALID_ARGUMENT", "--path is required");
      return exportTaskFile(config, context, bot, id, options["--path"]);
    case "task delivery":
      return delivery(config, context, bot, id, {
        state: options["--state"],
        reason: options["--reason"],
        artifactId: options["--artifact-id"],
      });
    case "task ack":
      return delivery(config, context, bot, id, {
        state: "delivered",
        receipt: options["--receipt"],
        artifactId: options["--artifact-id"],
      });
    case "task replay":
      return replayTaskEvent(config, context, bot, id);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && args[0] !== "--help" && process.env.CODEXHOST_BOT_LOCK_HELD !== "1") {
    if (process.platform !== "linux")
      fail("PLATFORM_UNSUPPORTED", "The unified Bot execution entry runs on Linux NAS");
    const config = await loadConfig();
    await mkdir(config.privateDir, { recursive: true, mode: 0o700 });
    // Kernel locks survive neither crashes nor reboots; record locks can then be safely reclaimed.
    const child = spawn(
      "flock",
      [
        "--wait",
        "10",
        "--conflict-exit-code",
        "75",
        path.join(config.privateDir, "integration.lock"),
        process.execPath,
        process.argv[1],
        ...args,
      ],
      {
        env: { ...process.env, CODEXHOST_BOT_LOCK_HELD: "1" },
        stdio: "inherit",
      },
    );
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", () =>
        reject(
          Object.assign(new Error("The NAS flock utility is required"), {
            code: "LOCK_UNAVAILABLE",
          }),
        ),
      );
      child.on("exit", (code) => resolve(code ?? 1));
    });
    if (process.exitCode === 75)
      fail("BUSY", "Another integration operation is active; retry the same request");
    return;
  }
  const result = await run(args);
  process.stdout.write(result.help ?? `${JSON.stringify(result)}\n`);
}

const entry = process.argv[1] && (await realpath(process.argv[1]).catch(() => undefined));
if (entry && pathToFileURL(entry).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ error: { code: error.code ?? "INTEGRATION_ERROR", message: error.message } })}\n`,
    );
    process.exitCode = 1;
  });
}
