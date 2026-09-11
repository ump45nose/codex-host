import { describe, expect, it } from "vitest";

import {
  DEFAULT_ZCODE_PROVIDER_BASE_URL,
  DEFAULT_ZCODE_PROVIDER_MODELS,
  resolveZcodeProviderConfiguration,
} from "../src/zcode-provider.js";

describe("ZCode Provider configuration", () => {
  it("stays disabled when the launcher did not opt in", () => {
    expect(resolveZcodeProviderConfiguration({})).toMatchObject({
      enabled: false,
      baseUrl: DEFAULT_ZCODE_PROVIDER_BASE_URL,
      defaultModel: DEFAULT_ZCODE_PROVIDER_MODELS[0],
    });
  });

  it("normalizes custom endpoints and preserves a requested default Model", () => {
    expect(
      resolveZcodeProviderConfiguration({
        CODEXHOST_ZCODE_ENABLED: "auto",
        CODEXHOST_ZCODE_BASE_URL: "https://proxy.example.test/root/",
        CODEXHOST_ZCODE_MODELS: "glm-custom, glm-5.3,glm-custom, invalid model",
        CODEXHOST_ZCODE_DEFAULT_MODEL: "glm-preferred",
        CODEXHOST_ZCODE_API_KEY: "proxy-secret",
      }),
    ).toEqual({
      enabled: true,
      baseUrl: "https://proxy.example.test/root/v1",
      apiKey: "proxy-secret",
      models: ["glm-preferred", "glm-custom", "glm-5.3"],
      defaultModel: "glm-preferred",
    });
  });

  it("rejects credentials embedded in the endpoint", () => {
    expect(() =>
      resolveZcodeProviderConfiguration({
        CODEXHOST_ZCODE_ENABLED: "1",
        CODEXHOST_ZCODE_BASE_URL: "http://user:password@127.0.0.1:8080/v1",
      }),
    ).toThrow(/uncredentialed/u);
  });
});
