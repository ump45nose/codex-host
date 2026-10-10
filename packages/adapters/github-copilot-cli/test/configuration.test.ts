import { describe, expect, it } from "vitest";
import { harnessInspectionSchema } from "@codexhost/shared-contracts";
import {
  COPILOT_PERMISSION_MODES,
  copilotConfiguration,
  copilotModelRef,
  copilotNativeModel,
} from "../src/configuration.js";

const opened = {
  configOptions: [
    {
      type: "select",
      id: "model",
      currentValue: "gpt-5-mini",
      options: [
        { value: "auto", name: "Auto" },
        { value: "auto", name: "Auto" }, // Copilot 1.0.89 repeats Auto in ACP.
        { value: "gpt-5-mini", name: "GPT-5 mini" },
      ],
    },
    {
      type: "select",
      id: "reasoning_effort",
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
    {
      type: "select",
      id: "allow_all",
      currentValue: "off",
      options: [
        { value: "on", name: "On" },
        { value: "off", name: "Off" },
      ],
    },
  ],
};

describe("Copilot ACP configuration", () => {
  it("deduplicates native models and maps confirmed live settings", () => {
    const config = copilotConfiguration(opened);
    expect(config.catalog.models).toHaveLength(2);
    expect(config.catalog.models[0]?.supportedThinkingOptionIds).toBeUndefined();
    expect(config.catalog.models[1]?.supportedThinkingOptionIds).toEqual(["low", "high"]);
    expect(config.state).toMatchObject({
      effectiveModel: copilotModelRef("gpt-5-mini"),
      effectiveThinkingOptionId: "low",
      effectivePermissionModeId: "supervised",
    });
    expect(
      harnessInspectionSchema.parse({
        status: "ready",
        catalog: config.catalog,
        capabilities: config.capabilities,
        permissionModes: COPILOT_PERMISSION_MODES,
      }),
    ).toBeDefined();
    expect(copilotNativeModel(copilotModelRef("gpt-5-mini").id)).toBe("gpt-5-mini");
  });
  it("retains every ACP-advertised Thinking Effort level for the selected Model", () => {
    const nativeOptions = [
      { value: "none", name: "None" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Extra High" },
      { value: "max", name: "Max" },
    ];
    const config = copilotConfiguration({
      configOptions: opened.configOptions.map((entry) =>
        entry.id === "reasoning_effort"
          ? { ...entry, currentValue: "medium", options: nativeOptions }
          : entry,
      ),
    });
    expect(config.catalog.thinkingOptions).toEqual(
      nativeOptions.map(({ value, name }) => ({ id: value, label: name })),
    );
    expect(
      config.catalog.models.find(({ ref }) => ref.id === copilotModelRef("gpt-5-mini").id)
        ?.supportedThinkingOptionIds,
    ).toEqual(nativeOptions.map(({ value }) => value));
    expect(
      config.catalog.models.find(({ ref }) => ref.id !== copilotModelRef("gpt-5-mini").id)
        ?.supportedThinkingOptionIds,
    ).toBeUndefined();
    expect(config.catalog.defaultThinkingOptionId).toBe("medium");
    expect(config.state.effectiveThinkingOptionId).toBe("medium");
  });

  it("formats raw ACP IDs but preserves a native descriptive label", () => {
    const config = copilotConfiguration({
      configOptions: opened.configOptions.map((entry) =>
        entry.id === "reasoning_effort"
          ? {
              ...entry,
              options: [
                { value: "low", name: "low" },
                { value: "xhigh", name: "xhigh" },
                { value: "max", name: "Maximum effort" },
              ],
            }
          : entry,
      ),
    });
    expect(config.catalog.thinkingOptions).toEqual([
      { id: "low", label: "Low" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Maximum effort" },
    ]);
  });

  it("rejects forged native model references and unconfirmed model catalogs", () => {
    expect(() => copilotNativeModel("copilot.invalid!")).toThrow("Invalid");
    expect(() => copilotConfiguration({ configOptions: [] })).toThrow("Model catalog");
    expect(() =>
      copilotConfiguration({
        configOptions: [{ ...opened.configOptions[0], currentValue: "missing" }],
      }),
    ).toThrow("selectable current Model");
  });
  it("does not advertise absent thinking or permission controls", () => {
    const config = copilotConfiguration({ configOptions: [opened.configOptions[0]] });
    expect(config.capabilities.configuration).toMatchObject({
      selectThinkingOption: false,
      selectPermissionMode: false,
    });
    expect(config.catalog.models[0]?.supportedThinkingOptionIds).toBeUndefined();
  });
});
