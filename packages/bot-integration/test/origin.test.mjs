import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOrigin, acknowledgeOrigin, originFile, clearOriginRequest } from "../src/origin.mjs";
import { startTask } from "../src/task.mjs";
import { readJson } from "../src/store.mjs";

describe("source Bot enrollment", () => {
  let root, config, context, routines;
  beforeEach(async () => {
    const temporary = path.resolve("outputs/.bot-integration-tests");
    await mkdir(temporary, { recursive: true });
    root = await mkdtemp(path.join(temporary, "origin-"));
    config = { privateDir: root, commandPath: "/installed/codexhost-bot", devices: [] };
    routines = new Map();
    context = {
      account: "a".repeat(64),
      team: null,
      computerId: "nas-native",
      backend: vi.fn(async (_service, method, body) => {
        if (method === "ListGrokBotAgents")
          return {
            agents: [
              { agentId: "bot-one", name: "One" },
              { agentId: "bot-two", name: "Two" },
            ],
          };
        if (method === "ListGrokBotAgentAutomations")
          return {
            automations: routines.has(body.agentId)
              ? [
                  {
                    automationId: `server-${body.agentId}`,
                    recordJson: JSON.stringify(routines.get(body.agentId)),
                  },
                ]
              : [],
          };
        if (method === "CreateAutomationWebhookApiKey")
          return { apiKey: `private-${body.automationId}` };
        throw new Error(`Unexpected protocol call ${method}`);
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  it("lets two source Bots create their own routines, automatically obtains credentials and verifies each callback", async () => {
    for (const bot of ["bot-one", "bot-two"]) {
      const setup = await ensureOrigin(config, context, bot);
      expect(setup.state).toBe("needsRoutine");
      expect(JSON.stringify(setup)).not.toContain("private-server");
      routines.set(bot, {
        id: `routine-${bot}`,
        ...setup.routine,
        prompt: `\n${setup.routine.prompt}\n`,
      });
      const pending = await ensureOrigin(config, context, bot);
      expect(pending.state).toBe("probePending");
      const binding = await readJson(originFile(config, context, bot));
      expect(binding.webhook.key).toBe(`private-server-${bot}`);
      expect(JSON.stringify(pending)).not.toContain(binding.webhook.key);
      expect((await acknowledgeOrigin(config, context, bot, binding.probe.nonce)).state).toBe(
        "verified",
      );
      expect((await acknowledgeOrigin(config, context, bot, binding.probe.nonce)).state).toBe(
        "verified",
      );
      expect((await ensureOrigin(config, context, bot)).state).toBe("verified");
    }
    expect(
      context.backend.mock.calls.filter(([, method]) => method === "CreateAutomationWebhookApiKey"),
    ).toHaveLength(2);
  });

  it("blocks dispatch before verification and rejects an unrelated or wrong-Bot acknowledgement", async () => {
    await expect(
      startTask(config, context, "bot-one", { device: "nas", task: "task" }),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_VERIFIED" });
    const setup = await ensureOrigin(config, context, "bot-one");
    routines.set("bot-one", { id: "one", ...setup.routine });
    await ensureOrigin(config, context, "bot-one");
    const binding = await readJson(originFile(config, context, "bot-one"));
    await expect(
      acknowledgeOrigin(config, context, "bot-two", binding.probe.nonce),
    ).rejects.toMatchObject({ code: "ORIGIN_PROBE_INVALID" });
    await expect(ensureOrigin(config, context, "foreign-bot")).rejects.toMatchObject({
      code: "ORIGIN_INVALID",
    });
  });

  it("issues only one creation request to concurrent first callers and reconciles after restart", async () => {
    const results = await Promise.all([
      ensureOrigin(config, context, "bot-one"),
      ensureOrigin(config, context, "bot-one"),
    ]);
    expect(results.filter((result) => result.state === "needsRoutine")).toHaveLength(1);
    const pending = results.find((result) => result.state === "routineCreationPending");
    expect(pending.routine).toBeUndefined();
    expect((await ensureOrigin(config, context, "bot-one")).state).toBe("routineCreationPending");
    const first = results.find((result) => result.state === "needsRoutine");
    routines.set("bot-one", { id: "native-assigned-id", ...first.routine });
    expect((await ensureOrigin(config, context, "bot-one")).state).toBe("probePending");
  });

  it("returns the original request after verification and clears it when cancelled", async () => {
    const original = { request: "Make a PNG and CSV", requestId: "stable-original-request" };
    const setup = await ensureOrigin(config, context, "bot-one", original);
    routines.set("bot-one", { id: "one", ...setup.routine });
    await ensureOrigin(config, context, "bot-one", original);
    const binding = await readJson(originFile(config, context, "bot-one"));
    const verified = await acknowledgeOrigin(config, context, "bot-one", binding.probe.nonce);
    expect(verified.pendingRequest).toMatchObject({
      id: original.requestId,
      text: original.request,
    });
    await expect(
      ensureOrigin(config, context, "bot-one", { request: "another", requestId: "other" }),
    ).rejects.toMatchObject({ code: "ORIGIN_REQUEST_PENDING" });
    expect(
      (await clearOriginRequest(config, context, "bot-one", original.requestId)).pendingRequest,
    ).toBeUndefined();
  });

  it("reuses the indexed routine after restart and never recreates a credential with an unknown result", async () => {
    const setup = await ensureOrigin(config, context, "bot-one");
    routines.set("bot-one", { id: "one", ...setup.routine });
    const original = context.backend.getMockImplementation();
    context.backend.mockImplementation(async (...args) => {
      if (args[1] === "CreateAutomationWebhookApiKey") throw new Error("connection lost");
      return original(...args);
    });
    await expect(ensureOrigin(config, context, "bot-one")).rejects.toThrow("connection lost");
    await expect(ensureOrigin(config, context, "bot-one")).rejects.toMatchObject({
      code: "ORIGIN_RECONCILE_REQUIRED",
    });
    expect(
      context.backend.mock.calls.filter(([, method]) => method === "CreateAutomationWebhookApiKey"),
    ).toHaveLength(1);
  });
});
