import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { readCopilotHistory } from "../src/native-history.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture(lines?: string[], nativeCwd?: string) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-copilot-history-"));
  homes.push(home);
  const id = randomUUID();
  const cwd = path.join(home, "workspace");
  await mkdir(cwd);
  const directory = path.join(home, ".copilot", "session-state", id);
  await mkdir(directory, { recursive: true });
  const start = JSON.stringify({
    id: randomUUID(),
    type: "session.start",
    data: {
      sessionId: id,
      version: 1,
      context: { cwd: nativeCwd ?? cwd },
    },
  });
  await writeFile(
    path.join(directory, "events.jsonl"),
    [start, ...(lines ?? [])].join("\n") + "\n",
  );
  return {
    home,
    id,
    cwd,
    directory,
    ref: nativeSessionRefSchema.parse({
      harnessId: "github-copilot-cli",
      nativeSessionId: id,
      formatVersion: 1,
      locator: { cwd },
    }),
  };
}
const event = (type: string, data: object, id = randomUUID()) => JSON.stringify({ type, data, id });

describe("Copilot native event history", () => {
  it("reads stable user identities and complete visible turns", async () => {
    const user = randomUUID();
    const f = await fixture([
      event("user.message", { content: "hello", turnId: "0" }, user),
      event("assistant.message", { content: "hi", turnId: "0", phase: "final_answer" }),
      event("assistant.turn_end", { turnId: "0" }),
    ]);
    const first = await readCopilotHistory(f.ref, { HOME: f.home });
    expect(first.turns).toHaveLength(1);
    expect(first.turns[0]).toMatchObject({
      nativeTurnRef: { nativeTurnKey: user },
      input: [{ text: "hello" }],
      outcome: { status: "unknown" },
      items: [{ item: { text: "hi", phase: "final_answer" } }],
    });
    expect(await readCopilotHistory(f.ref, { HOME: f.home })).toEqual(first);
  });
  it("restores native tool execution with stable ID and conservative outcome", async () => {
    const call = "call-one";
    const nativeId = randomUUID();
    const f = await fixture([
      event("user.message", { content: "run pwd", turnId: "0" }),
      event(
        "tool.execution_start",
        { turnId: "0", toolCallId: call, toolName: "bash", arguments: { command: "pwd" } },
        nativeId,
      ),
      event("tool.execution_complete", { turnId: "0", toolCallId: call, success: false }),
      event("assistant.turn_end", { turnId: "0" }),
    ]);
    const first = await readCopilotHistory(f.ref, { HOME: f.home });
    expect(first.turns[0]?.items).toMatchObject([
      {
        item: {
          type: "toolExecution",
          itemId: `copilot-history-${nativeId}`,
          toolName: "bash",
          arguments: { command: "pwd" },
        },
        outcome: { status: "failed" },
      },
    ]);
    expect(await readCopilotHistory(f.ref, { HOME: f.home })).toEqual(first);
  });
  it("restores the persisted result of a successful tool", async () => {
    const f = await fixture([
      event("user.message", { content: "read", turnId: "0" }),
      event("tool.execution_start", { turnId: "0", toolCallId: "call-2", toolName: "bash" }),
      event("tool.execution_complete", {
        turnId: "0",
        toolCallId: "call-2",
        success: true,
        result: { content: "read-only output" },
      }),
      event("assistant.turn_end", { turnId: "0" }),
    ]);
    expect((await readCopilotHistory(f.ref, { HOME: f.home })).turns[0]?.items).toMatchObject([
      {
        item: {
          type: "toolExecution",
          output: {
            content: [{ type: "text", text: "read-only output" }],
          },
        },
        outcome: { status: "succeeded" },
      },
    ]);
  });
  it("rejects a missing terminal Turn boundary, not an apparently completed transcript", async () => {
    const f = await fixture([event("user.message", { content: "unfinished", turnId: "0" })]);
    await expect(readCopilotHistory(f.ref, { HOME: f.home })).rejects.toThrow("unfinished Turn");
  });
  it("rejects missing, wrong workspace, and duplicate identities", async () => {
    const f = await fixture();
    await expect(
      readCopilotHistory({ ...f.ref, nativeSessionId: randomUUID() }, { HOME: f.home }),
    ).rejects.toThrow();
    await expect(
      readCopilotHistory({ ...f.ref, locator: { cwd: f.home } }, { HOME: f.home }),
    ).rejects.toThrow("workspace");
    const id = randomUUID();
    await writeFile(
      path.join(f.directory, "events.jsonl"),
      [
        event("session.start", { sessionId: f.id, version: 1, context: { cwd: f.cwd } }),
        event("user.message", { content: "a", turnId: "0" }, id),
        event("assistant.turn_end", { turnId: "0" }),
        event("user.message", { content: "b", turnId: "1" }, id),
      ].join("\n") + "\n",
    );
    await expect(readCopilotHistory(f.ref, { HOME: f.home })).rejects.toThrow("identity");
  });
  it("fails closed on incomplete boundaries and malformed committed lines", async () => {
    const f = await fixture([
      event("user.message", { content: "unfinished", turnId: "0" }),
      event("user.message", { content: "next", turnId: "1" }),
    ]);
    await expect(readCopilotHistory(f.ref, { HOME: f.home })).rejects.toThrow("unfinished Turn");
    await writeFile(path.join(f.directory, "events.jsonl"), `invalid\n`);
    await expect(readCopilotHistory(f.ref, { HOME: f.home })).rejects.toThrow("invalid JSON");
  });
});
