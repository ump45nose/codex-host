import { describe, expect, it } from "vitest";

import { createHarnessAdapter } from "../src/plugin.js";

describe("ZCode plugin construction", () => {
  it("creates an independent Harness and accepts an explicit ZCode command", async () => {
    const adapter = createHarnessAdapter({
      environment: {
        CODEXHOST_ZCODE_COMMAND: "/synthetic/zcode",
      },
      platform: "darwin",
      managedRemoteHost: false,
    });
    expect(adapter.harnessId).toBe("zcode");
    await adapter.close();
  });
});
