import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HostThreadSnapshot, HostTurnSnapshot } from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  jsonValueSchema,
  nativeTurnRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Copilot CLI 1.0.89's on-disk event format is native, not part of the public ACP contract.
 * Reject unknown identity/boundaries rather than fabricating a resumable transcript. */
export async function readCopilotHistory(
  ref: NativeSessionRef,
  environment: NodeJS.ProcessEnv,
): Promise<HostThreadSnapshot> {
  const sessionId = ref.nativeSessionId;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(sessionId))
    throw new Error("Invalid Copilot native Session ID");
  const cwd = object(ref.locator).cwd;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd))
    throw new Error("Copilot Session has no native working directory");
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  const root = environment.COPILOT_HOME?.trim() || path.join(home, ".copilot");
  const filename = path.join(root, "session-state", sessionId, "events.jsonl");
  const source = await readFile(filename, "utf8");
  if (Buffer.byteLength(source) > 32_000_000)
    throw new Error("Copilot native history exceeds read limit");
  const lines = source.split("\n");
  const events: Record<string, unknown>[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (!event || typeof event !== "object" || Array.isArray(event))
        throw new Error("Invalid event");
      events.push(event as Record<string, unknown>);
    } catch {
      // A final unterminated line can be a concurrent native append. Never accept it
      // as a completed Turn or mask malformed *complete* lines.
      if (index === lines.length - 1 && !source.endsWith("\n")) break;
      throw new Error("Copilot native history contains invalid JSON");
    }
  }
  const start = events[0];
  const metadata = object(start?.data);
  if (start?.type !== "session.start" || metadata.sessionId !== sessionId || metadata.version !== 1)
    throw new Error("Copilot native history identity or format mismatch");
  const nativeCwd = object(metadata.context).cwd;
  if (
    typeof nativeCwd !== "string" ||
    (path.resolve(nativeCwd) !== path.resolve(cwd) &&
      (await realpath(nativeCwd).catch(() => "")) !== (await realpath(cwd).catch(() => undefined)))
  )
    throw new Error("Copilot native Session workspace does not match");

  const turns: HostTurnSnapshot[] = [];
  const seen = new Set<string>();
  let current: HostTurnSnapshot | undefined;
  let nativeTurnId: string | undefined;
  let tools = new Map<string, HostTurnSnapshot["items"][number]>();
  for (const event of events.slice(1)) {
    const data = object(event.data);
    if (event.type === "user.message") {
      if (current) throw new Error("Copilot native history has an unfinished Turn");
      if (
        typeof event.id !== "string" ||
        !event.id ||
        seen.has(event.id) ||
        typeof data.content !== "string" ||
        (typeof data.turnId !== "string" && typeof data.turnId !== "number")
      )
        throw new Error("Copilot native user event has no stable identity");
      nativeTurnId = String(data.turnId);
      seen.add(event.id);
      current = {
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: ref.harnessId,
          nativeSessionId: sessionId,
          nativeTurnKey: event.id,
          formatVersion: 1,
        }),
        input: [{ type: "text", text: data.content }],
        items: [],
        outcome: { status: "unknown", reason: "Copilot did not persist a confirmed Turn outcome" },
      };
      turns.push(current);
      tools = new Map();
      continue;
    }
    if (!current) continue;
    if (event.type === "assistant.message" && typeof data.content === "string" && data.content) {
      if (
        String(data.turnId) !== nativeTurnId ||
        typeof event.id !== "string" ||
        !event.id ||
        seen.has(event.id)
      )
        throw new Error("Copilot assistant event identity mismatch");
      seen.add(event.id);
      current.items.push({
        item: {
          type: "agentMessage",
          itemId: hostItemIdSchema.parse(`copilot-history-${event.id}`),
          text: data.content,
          ...(data.phase === "final_answer" ? { phase: "final_answer" as const } : {}),
        },
        outcome: { status: "succeeded" },
      });
    }
    if (event.type === "tool.execution_start") {
      if (
        String(data.turnId) !== nativeTurnId ||
        typeof data.toolCallId !== "string" ||
        !data.toolCallId ||
        tools.has(data.toolCallId) ||
        typeof event.id !== "string" ||
        !event.id ||
        seen.has(event.id)
      )
        throw new Error("Copilot native tool start identity mismatch");
      seen.add(event.id);
      const argumentsValue = jsonValueSchema.safeParse(data.arguments ?? {});
      const snapshot: HostTurnSnapshot["items"][number] = {
        item: {
          type: "toolExecution",
          itemId: hostItemIdSchema.parse(`copilot-history-${event.id}`),
          toolName:
            typeof data.toolName === "string" && data.toolName ? data.toolName : "Copilot tool",
          arguments: argumentsValue.success ? argumentsValue.data : {},
        },
        outcome: { status: "cancelled", reason: "Native tool outcome was not persisted" },
      };
      current.items.push(snapshot);
      tools.set(data.toolCallId, snapshot);
    }
    if (event.type === "tool.execution_complete") {
      if (String(data.turnId) !== nativeTurnId || typeof data.toolCallId !== "string")
        throw new Error("Copilot native tool completion identity mismatch");
      const tool = tools.get(data.toolCallId);
      if (!tool) throw new Error("Copilot native tool completed without a matching start");
      if (tool.item.type === "toolExecution") {
        const result = object(data.result);
        if (typeof result.content === "string") {
          tool.item.output = {
            content: [{ type: "text", text: result.content.slice(0, 100_000) }],
            ...(result.content.length > 100_000 ? { truncated: true } : {}),
          };
        }
      }
      tool.outcome =
        data.success === true
          ? { status: "succeeded" }
          : data.success === false
            ? {
                status: "failed",
                error: { code: "nativeFailure", message: "Copilot tool failed", retryable: false },
              }
            : { status: "cancelled", reason: "Native tool outcome is unknown" };
      tools.delete(data.toolCallId);
    }
    if (event.type === "assistant.turn_end") {
      if (String(data.turnId) !== nativeTurnId)
        throw new Error("Copilot native Turn boundary mismatch");
      current = undefined;
      nativeTurnId = undefined;
      tools = new Map();
    }
  }
  if (current) throw new Error("Copilot native history has an unfinished Turn");
  return { turns };
}
