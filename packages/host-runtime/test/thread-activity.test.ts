import { describe, expect, it, vi } from "vitest";

import { ThreadActivity } from "../src/thread-activity.js";

describe("ThreadActivity", () => {
  it("counts any native event or interaction with a Thread identity, excluding polling replies", () => {
    const activity = new ThreadActivity();
    const listener = vi.fn();
    const unsubscribe = activity.subscribe(listener);
    activity.observeOfficial({ id: 1, result: { thread: { id: "thread" } } });
    activity.observeOfficial({ method: "account/updated", params: {} });
    expect(listener).not.toHaveBeenCalled();
    for (const method of [
      "turn/started",
      "item/reasoning/textDelta",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
      "item/commandExecution/requestApproval",
      "future/event",
    ]) {
      activity.observeOfficial({ method, params: { threadId: "thread" } });
    }
    expect(listener).toHaveBeenCalledTimes(6);
    expect(listener).toHaveBeenLastCalledWith(["thread"]);
    unsubscribe();
    activity.note("thread");
    expect(listener).toHaveBeenCalledTimes(6);
  });

  it("uses native subagent ancestry across nested children", () => {
    const activity = new ThreadActivity();
    const listener = vi.fn();
    activity.subscribe(listener);
    activity.observeOfficial({
      method: "thread/started",
      params: {
        thread: {
          id: "child",
          source: { subAgent: { thread_spawn: { parent_thread_id: "parent" } } },
        },
      },
    });
    activity.observeOfficial({
      method: "item/completed",
      params: {
        threadId: "child",
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          receiverThreadIds: ["grandchild"],
        },
      },
    });
    activity.observeOfficial({
      method: "item/agentMessage/delta",
      params: { threadId: "grandchild", delta: "progress" },
    });
    expect(listener).toHaveBeenLastCalledWith(["grandchild", "child", "parent"]);
  });

  it("does not turn sendInput recipients into children or loop on malformed ancestry", () => {
    const activity = new ThreadActivity();
    const listener = vi.fn();
    activity.subscribe(listener);
    activity.observeOfficial({
      method: "item/started",
      params: {
        threadId: "parent",
        item: { type: "collabAgentToolCall", tool: "sendInput", receiverThreadIds: ["other"] },
      },
    });
    activity.note("other");
    expect(listener).toHaveBeenLastCalledWith(["other"]);
    activity.note("a", "b");
    activity.note("b", "a");
    expect(listener).toHaveBeenLastCalledWith(["b", "a"]);
  });
});
