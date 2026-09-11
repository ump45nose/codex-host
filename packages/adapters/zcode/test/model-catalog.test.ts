import { describe, expect, it } from "vitest";

import {
  decodeZCodeModelRef,
  decodeZCodeThinkingOption,
  encodeZCodeModelRef,
  encodeZCodeThinkingOption,
  zcodeModelCatalog,
} from "../src/model-catalog.js";

describe("ZCode native model catalog", () => {
  it("round-trips native model and thought-level references", () => {
    const model = { providerId: "zai", modelId: "glm-5.3-flash" };
    expect(decodeZCodeModelRef(encodeZCodeModelRef(model))).toEqual(model);
    expect(decodeZCodeThinkingOption(encodeZCodeThinkingOption("max"))).toBe("max");
  });

  it("projects the app-server settings without a synthetic provider list", () => {
    const catalog = zcodeModelCatalog({
      settings: {
        model: {
          current: { providerId: "zai", modelId: "glm-5.3-flash" },
          available: [
            {
              label: "GLM-5.3 Flash",
              ref: { providerId: "zai", modelId: "glm-5.3-flash" },
            },
          ],
        },
        thoughtLevel: {
          current: "max",
          available: [{ label: "max", value: "max" }],
        },
      },
    });

    expect(catalog.models.map(({ label }) => label)).toEqual(["GLM-5.3 Flash"]);
    expect(catalog.defaultModel).toEqual(catalog.models[0]?.ref);
    expect(catalog.thinkingOptions.map(({ label }) => label)).toEqual(["max"]);
  });
});
