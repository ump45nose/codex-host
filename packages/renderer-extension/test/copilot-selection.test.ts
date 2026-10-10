import { describe, expect, it } from "vitest";
import {
  decodeHarnessPluginRoute,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { DraftAgentController, KNOWN_RENDERER_AGENTS } from "../src/agent-selection-state.js";
import { restoredThreadOwnership } from "../src/renderer-binding-probe.js";
import { modelSelectionForAgent } from "../src/versioned-renderer-adapter.js";
import { RENDERER_AGENT_INSTALL_URLS } from "../src/renderer-agent-picker.js";
import { RENDERER_AGENT_LABELS } from "../src/renderer-agent-icon.js";

describe("Copilot CLI Desktop selection", () => {
  it("isolates Copilot Model and Thinking and restores the generic plugin route", () => {
    expect(KNOWN_RENDERER_AGENTS).toContain("github-copilot-cli");
    const controller = new DraftAgentController<object>();
    const composer = {};
    const copilot = harnessModelRefSchema.parse({ id: "copilot.Z3B0LTUtbWluaQ" });
    const cursor = harnessModelRefSchema.parse({ id: "cursor.YXV0bw" });
    const high = harnessThinkingOptionIdSchema.parse("high");
    const supervised = harnessPermissionModeIdSchema.parse("supervised");
    controller.mount(composer, ["default"]);
    controller.setExternalModel(composer, "cursor-cli", cursor);
    controller.setExternalModel(composer, "github-copilot-cli", copilot);
    controller.setExternalThinkingOption(composer, "github-copilot-cli", high);
    expect(controller.modelForAgent(composer, "cursor-cli")).toEqual(cursor);
    expect(controller.modelForAgent(composer, "github-copilot-cli")).toEqual(copilot);
    expect(controller.thinkingOptionForAgent(composer, "github-copilot-cli")).toEqual(high);
    const selection = modelSelectionForAgent(
      null,
      null,
      "github-copilot-cli",
      copilot,
      high,
      supervised,
    );
    if (typeof selection?.model !== "string") throw Error("Missing Copilot carrier");
    expect(decodeHarnessPluginRoute(selection.model)).toMatchObject({
      harnessId: "github-copilot-cli",
      model: copilot,
      thinkingOptionId: high,
      permissionModeId: supervised,
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "github-copilot-cli",
        transportModelId: selection.model,
        locked: true,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      }),
    ).toEqual({
      agent: "github-copilot-cli",
      model: copilot,
      thinkingOptionId: high,
      permissionModeId: supervised,
    });
    expect(RENDERER_AGENT_LABELS["github-copilot-cli"]).toBe("GitHub Copilot CLI");
    expect(RENDERER_AGENT_INSTALL_URLS["github-copilot-cli"]).toBe(
      "https://docs.github.com/en/copilot/get-started/cli-quickstart",
    );
  });
  it("rejects a foreign plugin carrier for a Copilot-owned Thread", () => {
    const carrier = modelSelectionForAgent(null, null, "cursor-cli")?.model;
    expect(() =>
      restoredThreadOwnership({
        owner: "external",
        harnessId: "github-copilot-cli",
        transportModelId: String(carrier),
        locked: true,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      }),
    ).toThrow("incompatible");
  });
});
