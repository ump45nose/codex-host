import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest, fail, locked, readJson, saveJson } from "./store.mjs";

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function execute(command, args, environment, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let output = "",
      diagnostic = "",
      size = 0;
    const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) child.kill("SIGTERM");
      else output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (diagnostic.length < 16_384) diagnostic += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        Object.assign(new Error("Execution device could not be reached"), {
          code: "DEVICE_UNREACHABLE",
        }),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          resolve(JSON.parse(output));
        } catch {
          reject(
            Object.assign(new Error("Device returned unreadable CLI output"), {
              code: "DEVICE_RESPONSE_INVALID",
            }),
          );
        }
      } else {
        let error;
        try {
          error = JSON.parse(diagnostic.trim()).error;
        } catch {
          /* SSH diagnostics may contain paths. */
        }
        reject(
          Object.assign(
            new Error(error?.message ?? "Device command failed or its result is unknown"),
            { code: error?.code ?? "DEVICE_REQUEST_UNKNOWN" },
          ),
        );
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function deviceEnvironment(device, tokenFile) {
  return {
    PATH: `${path.dirname(device.node)}:${path.dirname(device.cli)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    CODEXHOST_CLI_NODE_PATH: device.node,
    CODEXHOST_DATA_DIR: device.dataDir,
    ...(tokenFile ? { CODEXHOST_CLIENT_TOKEN_FILE: tokenFile } : {}),
  };
}

export function invoke(device, args, tokenFile) {
  const environment = deviceEnvironment(device, tokenFile);
  if (device.transport === "local") {
    const clean = { ...process.env };
    for (const key of Object.keys(clean))
      if (key.startsWith("CODEXHOST_") || key === "CODEX_THREAD_ID") delete clean[key];
    return execute(device.cli, args, { ...clean, ...environment });
  }
  const command = [
    "env",
    "-u",
    "CODEXHOST_RUNTIME_ENDPOINT",
    "-u",
    "CODEXHOST_RUNTIME_TOKEN",
    "-u",
    "CODEXHOST_THREAD_ID",
    "-u",
    "CODEX_THREAD_ID",
    "-u",
    "CODEXHOST_CLIENT_TOKEN",
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    device.cli,
    ...args,
  ];
  return execute(
    "ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "StrictHostKeyChecking=yes",
      "-i",
      device.ssh.identityFile,
      device.ssh.destination,
      command.map(shellQuote).join(" "),
    ],
    process.env,
  );
}

/** Private bytes travel over stdin, never in process arguments or CLI responses. */
async function privateFile(device, file, content) {
  if (device.transport === "local") {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, content, { mode: 0o600 });
    await chmod(file, 0o600);
    return;
  }
  const script =
    'const fs=require("node:fs"),p=require("node:path"),f=process.argv[1];fs.mkdirSync(p.dirname(f),{recursive:true,mode:448});fs.writeFileSync(f,fs.readFileSync(0),{mode:384});fs.chmodSync(f,384);process.stdout.write("{}")';
  await execute(
    "ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "StrictHostKeyChecking=yes",
      "-i",
      device.ssh.identityFile,
      device.ssh.destination,
      [device.node, "-e", script, file].map(shellQuote).join(" "),
    ],
    process.env,
    content,
  );
}

export async function prepareWorkspace(device, directory) {
  const script =
    'const fs=require("node:fs"),p=require("node:path"),d=process.argv[1];for(const n of ["workspace","outputs","logs"])fs.mkdirSync(p.join(d,n),{recursive:true,mode:448});process.stdout.write("{}")';
  if (device.transport === "local") {
    for (const name of ["workspace", "outputs", "logs"])
      await mkdir(path.join(directory, name), { recursive: true, mode: 0o700 });
  } else {
    await execute(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "StrictHostKeyChecking=yes",
        "-i",
        device.ssh.identityFile,
        device.ssh.destination,
        [device.node, "-e", script, directory].map(shellQuote).join(" "),
      ],
      process.env,
    );
  }
}

export async function ensureClient(config, device, account, botId, webhook, savedName) {
  const name = savedName ?? `bot-${digest(`${account}:${botId}:${device.dataDir}`).slice(0, 32)}`;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name))
    fail("CLIENT_INVALID", "Saved client name is invalid");
  const recordFile = path.join(config.privateDir, account, "clients", device.id, `${name}.json`);
  return locked(`${recordFile}.lock`, async () => {
    let record = await readJson(recordFile);
    const tokenFile = path.join(device.privateDir, "clients", `${name}.token`);
    if (!record?.token) {
      const listing = await invoke(device, ["client", "list"]);
      if (listing.clients.some((client) => client.name === name))
        fail(
          "CLIENT_RECONCILE_REQUIRED",
          "A registered client has no saved credential; recover it before dispatch",
        );
      if (record?.state === "creating")
        fail("CLIENT_RECONCILE_REQUIRED", "Previous client creation has an unknown result");
      await saveJson(recordFile, { state: "creating", name });
      const created = await invoke(device, [
        "client",
        "add",
        name,
        "--scope",
        botId === "inventory" ? "read" : "dispatch",
        "--network",
        "local",
      ]);
      if (!created.token) fail("CLIENT_RECONCILE_REQUIRED", "Client credential was not returned");
      record = { name, token: created.token };
      await saveJson(recordFile, record);
    }
    if (record.tokenFile !== tokenFile) {
      await privateFile(device, tokenFile, `${record.token}\n`);
      record.tokenFile = tokenFile;
      await saveJson(recordFile, record);
    }
    const webhookDigest = webhook ? digest(JSON.stringify(webhook)) : undefined;
    if (webhook && record.webhookDigest !== webhookDigest) {
      const keyFile = path.join(device.privateDir, "clients", `${name}.webhook-key`);
      await privateFile(device, keyFile, `${webhook.key}\n`);
      await invoke(device, [
        "client",
        "webhook",
        name,
        "--adapter",
        "grok-bot",
        "--url",
        webhook.url,
        "--key-file",
        keyFile,
      ]);
      record.webhookDigest = webhookDigest;
      await saveJson(recordFile, record);
    }
    return { name, tokenFile };
  });
}

export async function devices(config, account, { query, refresh = false } = {}) {
  return {
    devices: await Promise.all(
      config.devices.map(async (device) => {
        try {
          const client = await ensureClient(config, device, account, "inventory");
          const [environment, harnesses, projects] = await Promise.all([
            invoke(device, ["host", "info", "--refresh", String(refresh)], client.tokenFile),
            invoke(device, ["harness", "list"], client.tokenFile),
            invoke(
              device,
              [
                "project",
                "list",
                "--limit",
                "100",
                "--refresh",
                String(refresh),
                ...(query ? ["--query", query] : []),
              ],
              client.tokenFile,
            ),
          ]);
          return {
            id: device.id,
            online: true,
            environment,
            ...harnesses,
            projects: projects.projects,
            projectScan: {
              observedAt: projects.observedAt,
              unavailableRoots: projects.unavailableRoots,
              truncated: projects.truncated,
              total: projects.total,
              nextOffset: projects.nextOffset,
            },
          };
        } catch (error) {
          return {
            id: device.id,
            online: error.code === "DEVICE_UNREACHABLE" ? false : null,
            status: "unavailable",
            error: { code: error.code ?? "DEVICE_ERROR", message: error.message },
          };
        }
      }),
    ),
  };
}
