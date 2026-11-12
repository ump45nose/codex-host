import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveJson } from "../src/store.mjs";
import { originFile } from "../src/origin.mjs";

const transport = vi.hoisted(() => ({
  invoke: vi.fn(),
  ensureClient: vi.fn(),
  prepareWorkspace: vi.fn(),
}));
vi.mock("../src/device.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  ...transport,
}));
import { startTask, readTask, changeTask, delivery, exportTaskFile } from "../src/task.mjs";

describe("task associations and delivery", () => {
  let directory, config, context;
  const request = {
    device: "macair",
    harness: "codex",
    cwd: "/project/bat",
    task: "Produce a final file",
    requestId: "request-one",
  };
  const snapshot = {
    threadId: "thread-one",
    status: "completed",
    turn: { turnId: "turn-one" },
    result: { availability: "available", text: "Done" },
  };
  beforeEach(async () => {
    await mkdir(path.resolve("outputs/.bot-integration-tests"), { recursive: true });
    directory = await mkdtemp(path.resolve("outputs/.bot-integration-tests/task-"));
    config = {
      privateDir: path.join(directory, "private"),
      exportDir: path.join(directory, "files"),
      devices: [{ id: "macair", dataDir: "/host/original" }],
    };
    context = {
      account: "account",
      team: null,
      backend: vi.fn(async () => ({ agents: [{ agentId: "source" }] })),
    };
    await saveJson(originFile(config, context, "source"), {
      account: "account",
      team: null,
      botId: "source",
      state: "verified",
      webhook: { url: "https://callback.invalid", key: "private-key" },
    });
    transport.invoke.mockReset();
    transport.ensureClient.mockReset();
    transport.prepareWorkspace.mockReset();
    transport.ensureClient.mockResolvedValue({ name: "client-one", tokenFile: "/private/token" });
    transport.invoke.mockImplementation(async (_device, args) => {
      if (args[0] === "delegate")
        return {
          threadId: "thread-one",
          turnId: "turn-one",
          deepLink: "codex://threads/thread-one",
          status: "running",
        };
      if (args[1] === "watch") return { state: "watching" };
      if (args[1] === "read") return snapshot;
      throw new Error(`Unexpected command ${args.join(" ")}`);
    });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps a stable request on its original device and never sends model overrides", async () => {
    const first = await startTask(config, context, "source", request);
    config.devices[0].dataDir = "/host/replacement";
    const repeated = await startTask(config, context, "source", request);
    await readTask(config, context, "source", first.taskId);
    expect(transport.ensureClient.mock.lastCall[1].dataDir).toBe("/host/original");
    expect(transport.ensureClient.mock.lastCall[5]).toBe("client-one");
    expect(repeated.taskId).toBe(first.taskId);
    const starts = transport.invoke.mock.calls.filter(([, args]) => args[0] === "delegate");
    expect(starts).toHaveLength(1);
    expect(starts[0][0].id).toBe("macair");
    expect(starts[0][1]).not.toContain("--model");
    expect(starts[0][1]).not.toContain("--thinking");
    await expect(
      startTask(config, context, "source", { ...request, task: "different" }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  });

  it("reconciles an unknown start by its original Host reference without creating another Turn", async () => {
    transport.invoke.mockRejectedValueOnce(
      Object.assign(new Error("lost response"), { code: "DEVICE_REQUEST_UNKNOWN" }),
    );
    await expect(startTask(config, context, "source", request)).rejects.toThrow("lost response");
    transport.invoke.mockImplementation(async (_device, args) => {
      if (args[1] === "list")
        return { threads: [{ threadId: "thread-one", deepLink: "codex://threads/thread-one" }] };
      if (args[1] === "read") return snapshot;
      if (args[1] === "watch") return { state: "alreadyTerminal" };
      throw new Error("Must not start again");
    });
    const task = await startTask(config, context, "source", request);
    expect(task.threadId).toBe("thread-one");
    expect(transport.invoke.mock.calls.filter(([, args]) => args[0] === "delegate")).toHaveLength(
      1,
    );
  });

  it("keeps delivery unknown until a native receipt is confirmed and deduplicates the completed Turn", async () => {
    const task = await startTask(config, context, "source", request);
    await delivery(config, context, "source", task.taskId, { state: "sending" });
    await delivery(config, context, "source", task.taskId, {
      state: "unknown",
      reason: "No send response",
    });
    await expect(
      delivery(config, context, "source", task.taskId, { state: "sending" }),
    ).rejects.toMatchObject({ code: "DELIVERY_RECONCILE_REQUIRED" });
    await expect(
      delivery(config, context, "source", task.taskId, { state: "delivered" }),
    ).rejects.toMatchObject({ code: "DELIVERY_RECEIPT_REQUIRED" });
    const confirmed = await delivery(config, context, "source", task.taskId, {
      state: "delivered",
      receipt: "native-attachment-one",
    });
    const duplicate = await delivery(config, context, "source", task.taskId, {
      state: "delivered",
      receipt: "different-receipt",
    });
    expect(duplicate).toEqual(confirmed);
  });

  it("reconciles an uncertain follow-up from its actual Turn and message without sending twice", async () => {
    const task = await startTask(config, context, "source", request);
    let sent = false,
      observedMessage = "unrelated message";
    transport.invoke.mockImplementation(async (_device, args) => {
      if (args[1] === "send") {
        sent = true;
        throw Object.assign(new Error("Response lost after Turn creation"), {
          code: "INTERNAL_ERROR",
        });
      }
      if (args.includes("--view"))
        return { messages: [{ role: "user", turnId: "turn-two", text: observedMessage }] };
      if (args[1] === "read")
        return { ...snapshot, turn: { turnId: sent ? "turn-two" : "turn-one" } };
      if (args[1] === "watch") return { state: "watching" };
      throw new Error("Unexpected command");
    });
    await expect(
      changeTask(config, context, "source", task.taskId, "send", "follow up"),
    ).rejects.toThrow("Response lost");
    expect((await readTask(config, context, "source", task.taskId)).pendingMutation).toBeDefined();
    await expect(
      changeTask(config, context, "source", task.taskId, "send", "follow up"),
    ).rejects.toMatchObject({ code: "MUTATION_RECONCILE_REQUIRED" });
    observedMessage = "follow up";
    expect(
      (await readTask(config, context, "source", task.taskId)).pendingMutation,
    ).toBeUndefined();
    expect(transport.invoke.mock.calls.filter(([, args]) => args[1] === "send")).toHaveLength(1);
  });

  it("writes binary Host chunks to a NAS file with a consistent revision", async () => {
    const task = await startTask(config, context, "source", request);
    const bytes = Buffer.from([0, 255, 10, 128, 64]);
    transport.invoke.mockImplementation(async (_device, args) => {
      if (args[1] === "read") return snapshot;
      const offset = args.includes("--offset") ? Number(args[args.indexOf("--offset") + 1]) : 0;
      const nextOffset = Math.min(bytes.length, offset + 3);
      const filename = path.basename(args[args.indexOf("--path") + 1]);
      return {
        filename,
        mimeType: filename.endsWith(".svg") ? "image/svg+xml" : "image/png",
        size: bytes.length,
        revision: "same",
        offset,
        nextOffset,
        eof: nextOffset === bytes.length,
        data: bytes.subarray(offset, nextOffset).toString("base64"),
      };
    });
    const result = await exportTaskFile(
      config,
      context,
      "source",
      task.taskId,
      "outputs/final.png",
    );
    expect(await readFile(result.file)).toEqual(bytes);
    expect(result.bytes).toBe(bytes.length);
    expect(transport.invoke.mock.calls.at(-2)[1]).toContain("--revision");
    await expect(
      delivery(config, context, "source", task.taskId, { state: "delivered", receipt: "batch" }),
    ).rejects.toMatchObject({ code: "DELIVERY_INCOMPLETE" });
    await delivery(config, context, "source", task.taskId, {
      state: "delivered",
      artifactId: result.artifactId,
      receipt: "file-confirmed",
    });
    const repeated = await exportTaskFile(
      config,
      context,
      "source",
      task.taskId,
      "outputs/final.png",
    );
    expect(repeated.delivery.state).toBe("delivered");
    expect(
      (
        await delivery(config, context, "source", task.taskId, {
          state: "delivered",
          receipt: "batch",
        })
      ).state,
    ).toBe("delivered");
    const source = await exportTaskFile(
      config,
      context,
      "source",
      task.taskId,
      "outputs/source.svg",
    );
    expect(source.delivery.state).toBe("pending");
    await delivery(config, context, "source", task.taskId, {
      state: "sending",
      artifactId: source.artifactId,
    });
    await delivery(config, context, "source", task.taskId, {
      state: "delivered",
      artifactId: source.artifactId,
      receipt: "source-confirmed",
    });
    const sourceAgain = await exportTaskFile(
      config,
      context,
      "source",
      task.taskId,
      "outputs/source.svg",
    );
    expect(sourceAgain.delivery).toMatchObject({
      state: "delivered",
      receipt: "source-confirmed",
    });
  });
});
