import { describe, expect, it } from "vitest";

import {
  decodeHarnessPluginRoute,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";

import { DraftAgentController, KNOWN_RENDERER_AGENTS } from "../src/agent-selection-state.js";
import { restoredThreadOwnership } from "../src/renderer-binding-probe.js";
import { RENDERER_AGENT_LABELS } from "../src/renderer-agent-icon.js";
import { RENDERER_AGENT_INSTALL_URLS } from "../src/renderer-agent-picker.js";
import { modelSelectionForAgent } from "../src/versioned-renderer-adapter.js";

describe("ZCode Renderer integration", () => {
  it("exposes ZCode as a selectable Harness and preserves its model configuration", () => {
    expect(KNOWN_RENDERER_AGENTS).toContain("zcode");
    expect(RENDERER_AGENT_LABELS.zcode).toBe("ZCode Weekend Plan");
    expect(RENDERER_AGENT_INSTALL_URLS.zcode).toBe("https://github.com/kingsword09/zcode-cli");

    const controller = new DraftAgentController<object>();
    const composer = {};
    const model = harnessModelRefSchema.parse({ id: "zcode-model-v1.test" });
    const thinking = harnessThinkingOptionIdSchema.parse("zcode-thinking-v1.high");
    controller.mount(composer, ["default"]);
    controller.setExternalModel(composer, "zcode", model);
    controller.setExternalThinkingOption(composer, "zcode", thinking);

    expect(controller.modelForAgent(composer, "zcode")).toEqual(model);
    expect(controller.thinkingOptionForAgent(composer, "zcode")).toBe(thinking);
  });

  it("routes new and restored ZCode Threads through the generic Harness carrier", () => {
    const model = harnessModelRefSchema.parse({ id: "zcode-model-v1.test" });
    const thinking = harnessThinkingOptionIdSchema.parse("zcode-thinking-v1.high");
    const selection = modelSelectionForAgent(null, null, "zcode", model, thinking);
    if (typeof selection?.model !== "string") throw new Error("Missing ZCode carrier");

    expect(decodeHarnessPluginRoute(selection.model)).toMatchObject({
      harnessId: "zcode",
      model,
      thinkingOptionId: thinking,
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "zcode",
        transportModelId: selection.model,
        locked: true,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      }),
    ).toEqual({ agent: "zcode", model, thinkingOptionId: thinking });
  });
});
