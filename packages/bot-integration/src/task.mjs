import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { digest, fail, locked, readJson, saveJson } from "./store.mjs";
import { getDevice } from "./config.mjs";
import { ensureClient, invoke, prepareWorkspace } from "./device.mjs";
import { requireOrigin, clearOriginRequest } from "./origin.mjs";

function taskDirectory(config, context, botId) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(botId ?? ""))
    fail("ORIGIN_INVALID", "Originating Bot ID is required");
  return path.join(config.privateDir, context.account, "tasks", botId);
}

function taskFile(config, context, botId, id) {
  if (!/^[a-f0-9]{32}$/u.test(id ?? "")) fail("TASK_INVALID", "Use the saved integration task ID");
  return path.join(taskDirectory(config, context, botId), `${id}.json`);
}

function publicTask(task) {
  return {
    taskId: task.id,
    device: task.device,
    client: task.client,
    requestId: task.requestId,
    threadId: task.start?.threadId,
    turnId: task.start?.turnId,
    link: task.start?.deepLink,
    start: task.start,
    delivery: task.delivery ?? {},
    ...(task.mutationUnknown ? { pendingMutation: task.mutationUnknown } : {}),
  };
}

async function loadTask(config, context, botId, id) {
  const task = await readJson(taskFile(config, context, botId, id));
  if (!task || task.account !== context.account || task.botId !== botId)
    fail("TASK_NOT_FOUND", "Task is not associated with this account and originating Bot");
  return task;
}

export async function startTask(config, context, botId, input) {
  const binding = await requireOrigin(config, context, botId);
  if (
    !input.task?.trim() ||
    !input.requestId ||
    input.requestId.length > 128 ||
    (input.cwd !== undefined && !path.isAbsolute(input.cwd))
  )
    fail(
      "TASK_INVALID",
      "Task text, stable request ID and an absolute workspace when specified are required",
    );
  const configuredDevice = getDevice(config, input.device);
  const id = digest(`${context.account}:${botId}:${input.requestId}`).slice(0, 32);
  const file = taskFile(config, context, botId, id);
  return locked(`${file}.lock`, async () => {
    let task = await readJson(file);
    const device = { ...configuredDevice, ...(task?.dataDir ? { dataDir: task.dataDir } : {}) };
    const client = await ensureClient(
      config,
      device,
      context.account,
      botId,
      binding.webhook,
      task?.client,
    );
    let cwd = input.cwd ?? task?.request.cwd;
    if (!cwd) {
      const environment = await invoke(device, ["host", "info"], client.tokenFile);
      if (!path.isAbsolute(environment.defaultWorkspace ?? ""))
        fail("WORKSPACE_UNAVAILABLE", "Device has no available default task workspace");
      cwd = path.join(
        environment.defaultWorkspace,
        `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-bot-task-${id.slice(0, 8)}`,
      );
      await prepareWorkspace(device, cwd);
    }
    const request = {
      device: device.id,
      harness: input.harness ?? "codex",
      cwd,
      task: input.task,
      taskName: input.taskName ?? null,
      requestId: input.requestId,
    };
    if (task && JSON.stringify(task.request) !== JSON.stringify(request))
      fail("REQUEST_CONFLICT", "This request ID already belongs to a different task or device");
    task ??= {
      id,
      account: context.account,
      botId,
      device: device.id,
      dataDir: device.dataDir,
      client: client.name,
      requestId: input.requestId,
      request,
      createdAt: new Date().toISOString(),
      ref: `codexhost-bot://task/${id}`,
      delivery: {},
    };
    if (!task.start && task.startAttemptedAt) {
      const matches = await invoke(
        device,
        ["thread", "list", "--ref", task.ref, "--limit", "100"],
        client.tokenFile,
      );
      if (matches.threads.length !== 1)
        fail(
          "START_RECONCILE_REQUIRED",
          "Previous start has an unknown result on its original device; no new task was started",
        );
      const existing = matches.threads[0];
      const snapshot = await invoke(
        device,
        ["thread", "read", existing.threadId],
        client.tokenFile,
      );
      task.start = { ...existing, turnId: snapshot.turn?.turnId ?? null };
    } else if (!task.start) {
      task.startAttemptedAt = new Date().toISOString();
      await saveJson(file, task);
      task.start = await invoke(
        device,
        [
          "delegate",
          "start",
          "--harness",
          request.harness,
          "--task",
          `${request.task}\n\n成品交付约束：本 Thread 的实际工作区是 ${request.cwd}。最终成品必须保存在该目录内，并在最终报告中用 Markdown 链接明确列出；工作区外的文件无法导出。保持项目 git 状态不变时，使用项目现有忽略的成品目录；不要修改忽略规则或已有源码。仅阅读其他项目时，将它作为参考，成品仍写到当前工作区。`,
          "--cwd",
          request.cwd,
          "--request-id",
          request.requestId,
          "--ref",
          task.ref,
          "--ref",
          `grokbot://bot/${encodeURIComponent(botId)}`,
          "--ref",
          `codexhost://device/${encodeURIComponent(device.id)}`,
          ...(request.taskName ? ["--task-name", request.taskName] : []),
        ],
        client.tokenFile,
      );
    }
    await saveJson(file, task);
    if (!task.start.watch || task.start.watch.state === "notRegistered") {
      task.start.watch = await invoke(
        device,
        ["thread", "watch", task.start.threadId, "--timeout-ms", "86400000"],
        client.tokenFile,
      );
      await saveJson(file, task);
    }
    if (binding.pendingRequest?.id === input.requestId)
      await clearOriginRequest(config, context, botId, input.requestId);
    return publicTask(task);
  });
}

async function taskConnection(config, context, botId, id) {
  const binding = await requireOrigin(config, context, botId);
  const task = await loadTask(config, context, botId, id);
  if (!task.start?.threadId)
    fail("START_RECONCILE_REQUIRED", "Task start must be reconciled on its original device");
  const device = {
    ...getDevice(config, task.device),
    ...(task.dataDir ? { dataDir: task.dataDir } : {}),
  };
  const client = await ensureClient(
    config,
    device,
    context.account,
    botId,
    binding.webhook,
    task.client,
  );
  return { task, device, client };
}

export async function readTask(config, context, botId, id) {
  let { task, device, client } = await taskConnection(config, context, botId, id);
  const snapshot = await invoke(device, ["thread", "read", task.start.threadId], client.tokenFile);
  const unknown = task.mutationUnknown;
  if (unknown) {
    let applied =
      unknown.command === "cancel" &&
      ["completed", "failed", "interrupted"].includes(snapshot.status);
    if (
      unknown.command === "send" &&
      snapshot.turn?.turnId &&
      snapshot.turn.turnId !== unknown.beforeTurnId
    ) {
      const page = await invoke(
        device,
        ["thread", "read", task.start.threadId, "--view", "messages", "--limit", "100"],
        client.tokenFile,
      );
      applied =
        page.messages?.some(
          (message) =>
            message.role === "user" &&
            message.turnId === snapshot.turn.turnId &&
            digest(message.text) === unknown.messageDigest,
        ) ?? false;
      if (applied)
        await invoke(
          device,
          ["thread", "watch", task.start.threadId, "--timeout-ms", "86400000"],
          client.tokenFile,
        );
    }
    if (applied) {
      const file = taskFile(config, context, botId, id);
      task = await locked(`${file}.lock`, async () => {
        const latest = await loadTask(config, context, botId, id);
        if (latest.mutationUnknown?.at === unknown.at) {
          delete latest.mutationUnknown;
          if (unknown.command === "send") latest.start.turnId = snapshot.turn.turnId;
          await saveJson(file, latest);
        }
        return latest;
      });
    }
  }
  const turn = snapshot.turn?.turnId ?? task.start.turnId;
  return { ...publicTask(task), snapshot, delivery: task.delivery?.[turn] ?? { state: "pending" } };
}

export async function changeTask(config, context, botId, id, command, message) {
  const file = taskFile(config, context, botId, id);
  return locked(`${file}.lock`, async () => {
    const { task, device, client } = await taskConnection(config, context, botId, id);
    if (task.mutationUnknown)
      fail(
        "MUTATION_RECONCILE_REQUIRED",
        "The previous follow-up or cancel has an unknown result; inspect the original Thread before retrying",
      );
    const before = await invoke(device, ["thread", "read", task.start.threadId], client.tokenFile);
    task.mutationUnknown = {
      command,
      at: new Date().toISOString(),
      beforeTurnId: before.turn?.turnId,
      ...(command === "send" ? { messageDigest: digest(message) } : {}),
    };
    await saveJson(file, task);
    let result;
    try {
      result = await invoke(
        device,
        [
          "thread",
          command,
          task.start.threadId,
          ...(command === "send" ? ["--message", message] : []),
        ],
        client.tokenFile,
      );
    } catch (error) {
      if (
        [
          "INVALID_ARGUMENT",
          "UNAUTHORIZED",
          "FORBIDDEN",
          "THREAD_NOT_FOUND",
          "THREAD_BUSY",
          "HARNESS_NOT_FOUND",
          "UNSUPPORTED",
          "DEVICE_UNREACHABLE",
        ].includes(error.code)
      ) {
        delete task.mutationUnknown;
        await saveJson(file, task);
      }
      throw error;
    }
    delete task.mutationUnknown;
    if (command === "send") task.start.turnId = result.turnId;
    await saveJson(file, task);
    if (command === "send")
      await invoke(
        device,
        ["thread", "watch", task.start.threadId, "--timeout-ms", "86400000"],
        client.tokenFile,
      );
    return { ...publicTask(task), result };
  });
}

/** Validate webhook hints against both the private association and the owning Host's event log. */
export async function resolveEvent(config, context, botId, threadId, eventId) {
  await requireOrigin(config, context, botId);
  const directory = taskDirectory(config, context, botId);
  const names = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const matches = [];
  for (const name of names.filter((name) => /^[a-f0-9]{32}\.json$/u.test(name))) {
    const task = await readJson(path.join(directory, name));
    if (task?.start?.threadId === threadId) matches.push(task);
  }
  if (matches.length !== 1)
    fail("EVENT_UNASSOCIATED", "Event does not identify one task belonging to this Bot");
  const task = matches[0];
  const { device, client } = await taskConnection(config, context, botId, task.id);
  const id = Number(eventId);
  if (!Number.isSafeInteger(id) || id < 1)
    fail("EVENT_INVALID", "A valid Host event ID is required");
  const page = await invoke(
    device,
    ["events", "--after", String(id - 1), "--limit", "1"],
    client.tokenFile,
  );
  const event = page.events.find((event) => event.id === id && event.threadId === threadId);
  if (!event)
    fail("EVENT_UNASSOCIATED", "Event was not found in the originating client's Host log");
  const result = await readTask(config, context, botId, task.id);
  if (event.turnId && result.snapshot.turn?.turnId && event.turnId !== result.snapshot.turn.turnId)
    return {
      taskId: task.id,
      ignored: true,
      reason: "A newer Turn exists; this event cannot deliver it",
    };
  task.webhookAccepted ??= {};
  task.webhookAccepted[id] = new Date().toISOString();
  await locked(`${taskFile(config, context, botId, task.id)}.lock`, async () => {
    const latest = await loadTask(config, context, botId, task.id);
    latest.webhookAccepted = { ...latest.webhookAccepted, [id]: task.webhookAccepted[id] };
    await saveJson(taskFile(config, context, botId, task.id), latest);
  });
  return { ...result, event };
}

export async function exportTaskFile(config, context, botId, id, requestedPath) {
  const { task, device, client } = await taskConnection(config, context, botId, id);
  const snapshot = await invoke(device, ["thread", "read", task.start.threadId], client.tokenFile);
  const turn = snapshot.turn?.turnId ?? task.start.turnId;
  if (!turn) fail("TASK_RESULT_UNAVAILABLE", "Task has no final Turn to export");
  const directory = path.join(
    config.exportDir,
    context.account,
    botId,
    id,
    digest(turn).slice(0, 24),
    digest(requestedPath).slice(0, 24),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let chunk = await invoke(
    device,
    ["thread", "file", task.start.threadId, "--path", requestedPath],
    client.tokenFile,
  );
  if (
    typeof chunk.filename !== "string" ||
    path.basename(chunk.filename) !== chunk.filename ||
    chunk.filename === "." ||
    chunk.filename === ".."
  )
    fail("FILE_RESPONSE_INVALID", "Host returned an invalid filename");
  const file = path.join(directory, chunk.filename);
  const temporary = `${file}.${process.pid}.partial`;
  const handle = await open(temporary, "wx", 0o600);
  const revision = chunk.revision;
  let offset = 0;
  try {
    while (true) {
      const bytes = Buffer.from(chunk.data, "base64");
      if (
        chunk.offset !== offset ||
        chunk.nextOffset !== offset + bytes.length ||
        chunk.revision !== revision ||
        chunk.size > 256 * 1024 * 1024 ||
        (!chunk.eof && bytes.length === 0)
      )
        fail("FILE_RESPONSE_INVALID", "Result chunks are inconsistent");
      await handle.writeFile(bytes);
      offset = chunk.nextOffset;
      if (chunk.eof) {
        if (offset !== chunk.size) fail("FILE_RESPONSE_INVALID", "Result file is incomplete");
        break;
      }
      chunk = await invoke(
        device,
        [
          "thread",
          "file",
          task.start.threadId,
          "--path",
          requestedPath,
          "--offset",
          String(offset),
          "--revision",
          revision,
        ],
        client.tokenFile,
      );
    }
    const current = await invoke(device, ["thread", "read", task.start.threadId], client.tokenFile);
    if ((current.turn?.turnId ?? task.start.turnId) !== turn)
      fail("TASK_CHANGED", "A newer Turn started during export; read the current result");
    await handle.close();
    await rename(temporary, file);
    const artifactId = digest(`${requestedPath}:${revision}`).slice(0, 32);
    const exported = {
      artifactId,
      taskId: id,
      device: device.id,
      turnId: turn,
      file,
      filename: chunk.filename,
      mimeType: chunk.mimeType,
      bytes: offset,
      revision,
    };
    let delivered;
    await locked(`${taskFile(config, context, botId, id)}.lock`, async () => {
      const latest = await loadTask(config, context, botId, id);
      latest.exports ??= {};
      latest.exports[turn] ??= {};
      latest.exports[turn][artifactId] = exported;
      delivered = latest.delivery?.[turn]?.files?.[artifactId];
      await saveJson(taskFile(config, context, botId, id), latest);
    });
    return { ...exported, delivery: delivered ?? { state: "pending" } };
  } finally {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

/** Delivery is separate from Host terminal status and webhook HTTP acceptance. */
export async function delivery(config, context, botId, id, input) {
  const file = taskFile(config, context, botId, id);
  return locked(`${file}.lock`, async () => {
    const { task, device, client } = await taskConnection(config, context, botId, id);
    const snapshot = await invoke(
      device,
      ["thread", "read", task.start.threadId],
      client.tokenFile,
    );
    const turn = snapshot.turn?.turnId ?? task.start.turnId;
    if (!turn || !["completed", "failed", "interrupted"].includes(snapshot.status))
      fail("TASK_NOT_TERMINAL", "Read the real terminal result before recording delivery");
    task.delivery ??= {};
    const entry = task.delivery[turn] ?? { state: "pending", files: {} };
    entry.files ??= {};
    if (input.artifactId && !task.exports?.[turn]?.[input.artifactId])
      fail("ARTIFACT_UNKNOWN", "The attachment must be exported from this task and Turn first");
    const previous = input.artifactId ? entry.files[input.artifactId] : entry;
    if (previous?.state === "delivered")
      return {
        taskId: id,
        device: device.id,
        client: client.name,
        turnId: turn,
        ...(input.artifactId ? { artifactId: input.artifactId } : {}),
        ...previous,
      };
    if (input.state === "delivered" && !input.receipt?.trim())
      fail(
        "DELIVERY_RECEIPT_REQUIRED",
        "A confirmed native message or attachment receipt is required",
      );
    if (input.state === "sending" && ["sending", "unknown"].includes(previous?.state))
      fail("DELIVERY_RECONCILE_REQUIRED", "Inspect the originating DM before sending again");
    if (!["sending", "unknown", "failed", "delivered"].includes(input.state))
      fail("DELIVERY_INVALID", "Invalid delivery state");
    if (
      input.state === "delivered" &&
      !input.artifactId &&
      Object.keys(task.exports?.[turn] ?? {}).some(
        (artifact) => entry.files[artifact]?.state !== "delivered",
      )
    )
      fail(
        "DELIVERY_INCOMPLETE",
        "Confirm each exported attachment before acknowledging the whole Turn",
      );
    const next = {
      state: input.state,
      at: new Date().toISOString(),
      ...(input.receipt ? { receipt: input.receipt } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    if (input.artifactId) {
      entry.files[input.artifactId] = next;
      if (entry.state !== "delivered") entry.state = "partial";
      task.delivery[turn] = entry;
    } else task.delivery[turn] = { ...next, files: entry.files };
    await saveJson(file, task);
    return {
      taskId: id,
      device: device.id,
      client: client.name,
      turnId: turn,
      ...(input.artifactId ? { artifactId: input.artifactId, ...next } : task.delivery[turn]),
    };
  });
}

/** Repost an existing Host event after callback repair; this never starts or resends an Agent Turn. */
export async function replayTaskEvent(config, context, botId, id) {
  const binding = await requireOrigin(config, context, botId);
  const { task, device, client } = await taskConnection(config, context, botId, id);
  let after = 0,
    event;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await invoke(
      device,
      ["events", "--after", String(after), "--limit", "100"],
      client.tokenFile,
    );
    for (const candidate of page.events)
      if (candidate.threadId === task.start.threadId) event = candidate;
    if (page.events.length < 100) break;
    after = page.cursor;
  }
  if (!event)
    fail("EVENT_NOT_FOUND", "No retained Host event exists for this task; read its current result");
  const response = await fetch(binding.webhook.url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      authorization: `Bearer ${binding.webhook.key}`,
      "content-type": "application/json",
      "idempotency-key": `${client.name}:${event.id}`,
    },
    body: JSON.stringify(event),
  });
  if (!response.ok) fail("WEBHOOK_REPLAY_FAILED", `Callback returned HTTP ${response.status}`);
  return { taskId: id, eventId: event.id, webhookAccepted: true, delivered: false };
}
