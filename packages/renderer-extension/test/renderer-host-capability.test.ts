import { describe, expect, it } from "vitest";

import { supportsCodexHostPrivateRpc } from "../src/renderer-host-capability.js";

describe("Renderer Host capability boundary", () => {
  it("keeps private RPC away from stock discovered SSH hosts", () => {
    expect(supportsCodexHostPrivateRpc("remote-ssh-discovered:nas")).toBe(false);
    expect(supportsCodexHostPrivateRpc("local")).toBe(true);
    expect(supportsCodexHostPrivateRpc("remote-control:nas")).toBe(true);
    expect(supportsCodexHostPrivateRpc("remote-ssh-codex-managed:nas")).toBe(true);
  });
});
