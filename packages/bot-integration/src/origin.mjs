import { randomBytes } from "node:crypto";
import path from "node:path";
import { fail, locked, readJson, saveJson } from "./store.mjs";
import { sourceBot } from "./grok.mjs";
import { shellQuote } from "./device.mjs";

export function originFile(config, context, botId) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(botId ?? ""))
    fail("ORIGIN_INVALID", "Originating Bot ID is required");
  return path.join(config.privateDir, context.account, "origins", botId, "binding.json");
}

function publicStatus(binding, context, botId) {
  return {
    account: context.account.slice(0, 12),
    botId,
    name: binding?.botName,
    state: binding?.state ?? "unregistered",
    verifiedAt: binding?.verifiedAt,
    ...(binding?.pendingRequest ? { pendingRequest: binding.pendingRequest } : {}),
  };
}

function routineSpec(config, context, botId, marker) {
  const command = shellQuote(config.commandPath);
  const bot = shellQuote(botId);
  return {
    name: "CodexHost 任务回执",
    trigger: { type: "webhook" },
    isEnabled: true,
    prompt: [
      "这是当前来源 Bot 的 CodexHost 回执入口，只回复当前 Bot 的原私聊，不向其他 Bot 转发。",
      `集成标记：${marker}`,
      `先确认自己的真实 Bot ID 为 ${botId}；不一致则停止。`,
      `所有集成命令通过官方本机执行能力选择 NAS computerId=${context.computerId}，使用 ${command}。`,
      "解析 Webhook JSON：有 context 时取 context（字符串先解析）；没有 context 时直接读取整个事件对象。",
      `kind=codexhost.origin.probe 时：执行 ${command} origin ack --bot ${bot} --nonce <nonce>；nonce 只接受 48 位十六进制。`,
      "确认 verified 后，只在 ack 返回 pendingRequest 时接续：用其中 text 作为原始用户任务，按共享委派 Skill 选择设备与 Agent；task start 必须复用 pendingRequest.id 作为 --request-id。没有 pendingRequest 就结束，不猜测或重做历史任务。用户已取消则 origin cancel 清除该请求。不要展示注册细节。",
      `type=watch 时：执行 ${command} task resolve --bot ${bot} --thread <threadId> --event <id>，只处理有来源关联的任务。`,
      "读取返回的真实任务终态；运行中或 stalled 只更新进度，不当作完成。",
      "已交付则静默结束。未交付时读取最终报告；只取最终成品，用 task export --bot <当前BotID> --task-id <任务ID> --path <报告明确链接的文件> 导出。源文件仅在用户要求时取。",
      "通过官方 NAS 本机文件传输工具发送导出文件到自己的原私聊：图片用原生预览，其他文件用附件。只附一句简短结果，不发日志、路径、Base64 或技术配置。",
      "每个导出文件有 artifactId 和 delivery。已 delivered 的文件不重发；其他文件发送前 task delivery --artifact-id <ID> --state sending；收到平台确认后 task ack --artifact-id <ID> --receipt <真实附件ID>，两者都带 --bot 和 --task-id。全部文件确认后再 task ack --receipt <实际平台回执> 标记整个 Turn 交付。发送失败记录 failed 和原因，发送结果未知记录 unknown，先核查原私聊，不能盲目重发或重新执行任务。",
      "不读取或展示凭据，不修改其他 routine。未知事件、来源不匹配、未验证绑定都停止。",
    ].join("\n"),
  };
}

export async function originStatus(config, context, botId) {
  return publicStatus(await readJson(originFile(config, context, botId)), context, botId);
}

/** Registration continuation only; Agent execution remains entirely in the Host. */
export async function clearOriginRequest(config, context, botId, requestId) {
  await sourceBot(context, botId);
  const file = originFile(config, context, botId);
  return locked(`${file}.lock`, async () => {
    const binding = await readJson(file);
    if (!requestId || (binding?.pendingRequest && binding.pendingRequest.id !== requestId))
      fail("ORIGIN_REQUEST_INVALID", "The pending request ID must match");
    if (binding?.pendingRequest) {
      delete binding.pendingRequest;
      await saveJson(file, binding);
    }
    return publicStatus(binding, context, botId);
  });
}

export async function requireOrigin(config, context, botId) {
  await sourceBot(context, botId);
  const binding = await readJson(originFile(config, context, botId));
  if (
    binding?.state !== "verified" ||
    binding.account !== context.account ||
    binding.botId !== botId ||
    (binding.team ?? null) !== context.team
  )
    fail("ORIGIN_NOT_VERIFIED", "Origin registration must finish before a user task can start");
  return binding;
}

/** Returns pending states promptly so the same Bot can receive and acknowledge its probe. */
export async function ensureOrigin(config, context, botId, options = {}) {
  const source = await sourceBot(context, botId);
  const file = originFile(config, context, botId);
  return locked(`${file}.lock`, async () => {
    let binding = await readJson(file);
    if (binding && (binding.account !== context.account || (binding.team ?? null) !== context.team))
      fail("ACCOUNT_CHANGED", "Origin binding belongs to a different account authorization");
    const marker = `codexhost-origin:${context.account}:${botId}`;
    const response = await context.backend("GrokBotService", "ListGrokBotAgentAutomations", {
      agentId: botId,
    });
    const routines = (response.automations ?? []).flatMap((entry) => {
      try {
        const record = JSON.parse(entry.recordJson);
        return record.prompt?.includes(marker) ? [{ ...record, serverId: entry.automationId }] : [];
      } catch {
        return [];
      }
    });
    if (routines.length > 1)
      fail("ORIGIN_DUPLICATE", "Multiple origin routines require reconciliation; no task started");
    binding ??= {
      account: context.account,
      team: context.team,
      botId,
      botName: source.name,
      state: "unregistered",
    };
    if (options.request !== undefined) {
      if (!options.request.trim() || !options.requestId || options.requestId.length > 128)
        fail("ORIGIN_REQUEST_INVALID", "The original request and a stable request ID are required");
      const previous = binding.pendingRequest;
      if (previous && (previous.id !== options.requestId || previous.text !== options.request))
        fail(
          "ORIGIN_REQUEST_PENDING",
          "Finish or cancel the original pending registration request first",
        );
      binding.pendingRequest ??= {
        id: options.requestId,
        text: options.request,
        createdAt: new Date().toISOString(),
      };
      await saveJson(file, binding);
    }
    const routine = routines[0];
    if (!routine) {
      if (binding.serverRoutineId)
        fail(
          "ORIGIN_MISSING",
          "The registered origin routine is missing; reconcile it before dispatch",
        );
      if (binding.routineCreationRequestedAt) {
        binding.state = "routineCreationPending";
        await saveJson(file, binding);
        return {
          ...publicStatus(binding, context, botId),
          integrationMarker: marker,
          next: "A previous caller already received the creation request. Query your native routines and reconcile that attempt; do not create another routine. No user task started.",
        };
      }
      binding.routineCreationRequestedAt = new Date().toISOString();
      binding.state = "needsRoutine";
      await saveJson(file, binding);
      return {
        ...publicStatus(binding, context, botId),
        integrationMarker: marker,
        routine: routineSpec(config, context, botId, marker),
        next: "Use your current native routine tool to create this webhook routine once, then call origin ensure again. No user task has started.",
      };
    }
    const expected = routineSpec(config, context, botId, marker);
    const required = [
      marker,
      config.commandPath,
      context.computerId,
      "origin ack",
      "task resolve",
      "task export",
      "--artifact-id",
      "task ack",
    ];
    if (!required.every((part) => routine.prompt.includes(part))) {
      binding.state = "needsRoutineUpdate";
      delete binding.verifiedAt;
      await saveJson(file, binding);
      return {
        ...publicStatus(binding, context, botId),
        routineId: routine.id,
        integrationMarker: marker,
        routine: expected,
        next: "Update the existing native routine to this spec without creating a second routine, then call origin ensure again. No task started.",
      };
    }
    if (binding.serverRoutineId && binding.serverRoutineId !== routine.serverId && !options.repair)
      fail(
        "ORIGIN_CHANGED",
        "The origin routine changed; reconcile its credential before dispatch",
      );
    if (options.repair) {
      if (binding.state === "credentialCreating")
        fail("ORIGIN_RECONCILE_REQUIRED", "Unknown credential creation must be reconciled first");
      binding.state = "credentialSaved";
      delete binding.verifiedAt;
      if (binding.serverRoutineId !== routine.serverId) delete binding.webhook;
    }
    if (routine.isEnabled === false)
      fail("ORIGIN_DISABLED", "Origin routine is disabled; no user task started");
    binding.serverRoutineId = routine.serverId;
    binding.routineId = routine.id;
    if (!binding.webhook) {
      if (binding.state === "credentialCreating")
        fail(
          "ORIGIN_RECONCILE_REQUIRED",
          "Previous credential creation has an unknown result; no task started",
        );
      binding.state = "credentialCreating";
      await saveJson(file, binding);
      const result = await context.backend("DashboardService", "CreateAutomationWebhookApiKey", {
        automationId: routine.serverId,
        name: "codexhost-native-integration",
      });
      if (!result.apiKey) fail("ORIGIN_RECONCILE_REQUIRED", "Origin credential was not returned");
      binding.webhook = {
        url: `https://api2.cursor.sh/automations/webhook/${encodeURIComponent(routine.serverId)}`,
        key: result.apiKey,
      };
      binding.state = "credentialSaved";
      await saveJson(file, binding);
    }
    if (binding.state === "verified") return publicStatus(binding, context, botId);
    if (binding.state !== "probePending" || Date.now() - binding.probe.startedAt > 600_000) {
      binding.probe = { nonce: randomBytes(24).toString("hex"), startedAt: Date.now() };
      binding.state = "probePending";
      await saveJson(file, binding);
      const response = await fetch(binding.webhook.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          authorization: `Bearer ${binding.webhook.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          context: JSON.stringify({
            kind: "codexhost.origin.probe",
            originBotId: botId,
            nonce: binding.probe.nonce,
          }),
        }),
      });
      if (!response.ok) {
        binding.state = "probeRejected";
        if (response.status === 401 || response.status === 403) delete binding.webhook;
        await saveJson(file, binding);
        fail(
          "ORIGIN_PROBE_FAILED",
          `Origin probe returned HTTP ${response.status}; no task started`,
        );
      }
      binding.probe.acceptedAt = new Date().toISOString();
      await saveJson(file, binding);
    }
    return {
      ...publicStatus(binding, context, botId),
      next: "End this turn so your own routine can acknowledge the probe, then continue the pending user request. No user task has started.",
    };
  });
}

export async function acknowledgeOrigin(config, context, botId, nonce) {
  await sourceBot(context, botId);
  const file = originFile(config, context, botId);
  return locked(`${file}.lock`, async () => {
    const binding = await readJson(file);
    if (binding?.state === "verified" && binding.probe?.nonce === nonce)
      return publicStatus(binding, context, botId);
    if (
      binding?.state !== "probePending" ||
      binding.botId !== botId ||
      binding.account !== context.account ||
      !/^[a-f0-9]{48}$/u.test(nonce ?? "") ||
      binding.probe?.nonce !== nonce ||
      Date.now() - binding.probe.startedAt > 600_000
    )
      fail("ORIGIN_PROBE_INVALID", "Origin verification is invalid or expired");
    binding.state = "verified";
    binding.verifiedAt = new Date().toISOString();
    await saveJson(file, binding);
    return publicStatus(binding, context, botId);
  });
}
