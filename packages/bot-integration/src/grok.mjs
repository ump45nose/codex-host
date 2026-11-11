import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readJson, fail } from "./store.mjs";

/** Isolated private protocol adapter. Official execution and file transfer stay in the native daemon. */
export async function grokAccount(config) {
  const controller = await import(pathToFileURL(config.grok.controller).href);
  const machine = await readJson(config.grok.machine);
  const initial = await readJson(config.grok.credentials);
  let payload;
  try {
    payload = JSON.parse(Buffer.from(initial.accessToken.split(".")[1], "base64url"));
  } catch {
    fail("LOGIN_REQUIRED", "The NAS native execution account needs login");
  }
  if (!payload.sub || !machine?.machineId)
    fail("LOGIN_REQUIRED", "A stable NAS account and machine identity are required");
  const account = controller.accountScope(initial.accessToken);
  const team = initial.selectedTeamId ?? null;
  async function backend(service, method, body) {
    const credentials = await readJson(config.grok.credentials);
    if (
      !credentials?.accessToken ||
      controller.accountScope(credentials.accessToken) !== account ||
      (credentials.selectedTeamId ?? null) !== team
    )
      fail("ACCOUNT_CHANGED", "The signed-in account changed; use its own integration namespace");
    const response = await fetch(`https://api2.cursor.sh/aiserver.v1.${service}/${method}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        ...(team === null ? {} : { "x-cursor-team-id": String(team) }),
        "x-cursor-checksum": controller.cursorChecksum(machine.machineId),
        "x-cursor-client-type": "sand",
        "x-cursor-client-version": config.grok.version,
        "x-sand-box-namespace": "prod",
        "x-ghost-mode": "true",
        "x-request-id": randomUUID(),
        "connect-protocol-version": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      fail(
        response.status === 401 ? "LOGIN_REQUIRED" : "GROK_REQUEST_FAILED",
        `Grok Bot ${method} returned HTTP ${response.status}`,
      );
    return response.json();
  }
  return { account, team, computerId: machine.machineId, backend };
}

export async function sourceBot(context, botId) {
  if (typeof botId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(botId))
    fail("ORIGIN_INVALID", "The real originating Bot ID is required");
  const { agents } = await context.backend("GrokBotService", "ListGrokBotAgents", {});
  const bot = agents?.find((agent) => agent.agentId === botId);
  if (!bot) fail("ORIGIN_INVALID", "Originating Bot does not belong to the signed-in account");
  return bot;
}
