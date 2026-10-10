import { describe, expect, it, vi } from "vitest";
import type { CopilotClient } from "../src/acp-client.js";
import { inspectCopilotCatalog } from "../src/catalog.js";
import { copilotModelRef } from "../src/configuration.js";

function setup() {
  let model = "auto";
  let reasoning = "low";
  const configuration = () => ({
    sessionId: "inspection",
    configOptions: [
      {
        type: "select",
        id: "model",
        currentValue: model,
        options: [
          { value: "auto", name: "Auto" },
          { value: "other", name: "Other" },
        ],
      },
      {
        type: "select",
        id: "reasoning_effort",
        currentValue: reasoning,
        options: (model === "auto" ? ["low", "high"] : ["medium"]).map((value) => ({
          value,
          name: value,
        })),
      },
    ],
  });
  const opened = configuration();
  const setConfigOption = vi.fn(async (_session: string, key: string, value: string) => {
    if (key === "model") {
      model = value;
      reasoning = model === "auto" ? "high" : "medium";
    } else reasoning = value;
    return configuration();
  });
  return {
    opened,
    configuration,
    setConfigOption,
    client: { setConfigOption } as unknown as CopilotClient,
  };
}

describe("Copilot native catalog inspection", () => {
  it("queries reasoning per native model for both context variants and restores settings", async () => {
    const f = setup();
    const result = await inspectCopilotCatalog(f.client, f.opened);
    for (const context of ["default", "long_context"] as const) {
      expect(
        result.catalog.models.find(({ ref }) => ref.id === copilotModelRef("other", context).id)
          ?.supportedThinkingOptionIds,
      ).toEqual(["medium"]);
      expect(
        result.catalog.models.find(({ ref }) => ref.id === copilotModelRef("auto", context).id)
          ?.supportedThinkingOptionIds,
      ).toEqual(["low", "high"]);
    }
    expect(result.catalog.thinkingOptions.map(({ id }) => id)).toEqual(["low", "high", "medium"]);
    expect(f.configuration()).toEqual(f.opened);
    expect(f.setConfigOption.mock.calls.map(([, key, value]) => `${key}:${value}`)).toEqual([
      "model:other",
      "model:auto",
      "reasoning_effort:low",
    ]);
  });

  it("restores the original model and reasoning when another model fails inspection", async () => {
    const f = setup();
    f.setConfigOption.mockRejectedValueOnce(new Error("native selection failed"));
    await expect(inspectCopilotCatalog(f.client, f.opened)).rejects.toThrow(
      "native selection failed",
    );
    expect(f.configuration()).toEqual(f.opened);
    expect(f.setConfigOption.mock.calls.at(-1)?.slice(1)).toEqual(["reasoning_effort", "low"]);
  });
});
