import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import type { DelegationControlApi } from "../src/delegation-types.js";
import { externalClientRouter } from "../src/external-client-routes.js";
import {
  startExternalClientServer,
  type ExternalClientServer,
} from "../src/external-client-server.js";
import { ExternalClientRegistry } from "../src/external-clients.js";

describe("client scopes and networks", () => {
  let directory: string;
  let file: string;
  const servers: ExternalClientServer[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-access-"));
    file = path.join(directory, "external-clients.json");
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps clients registered before scopes at dispatch on the local network", async () => {
    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
        clients: [{ name: "old", createdAt: "2026-11-01T00:00:00Z", salt: "aa", tokenHash: "bb" }],
      }),
    );
    const registry = new ExternalClientRegistry(file);
    await expect(registry.list()).resolves.toEqual([
      { name: "old", createdAt: "2026-11-01T00:00:00Z", scope: "dispatch", networks: ["local"] },
    ]);
    await expect(registry.has("old", "local")).resolves.toBe(true);
    await expect(registry.has("old", "tailnet")).resolves.toBe(false);
  });

  it("sets scope and networks from the CLI and validates them", async () => {
    const environment = { CODEXHOST_DATA_DIR: directory };
    const run = async (arguments_: string[]) => {
      const output = new PassThrough();
      const diagnosticOutput = new PassThrough();
      const code = await runDelegationCli({
        arguments: arguments_,
        environment,
        output,
        diagnosticOutput,
      });
      return { code, body: JSON.parse(String((code === 0 ? output : diagnosticOutput).read())) };
    };
    await expect(
      run(["client", "add", "bot", "--scope", "read", "--network", "local,tailnet"]),
    ).resolves.toMatchObject({
      code: 0,
      body: { name: "bot", scope: "read", networks: ["local", "tailnet"] },
    });
    await expect(run(["client", "set", "bot", "--scope", "dispatch"])).resolves.toMatchObject({
      body: { scope: "dispatch", networks: ["local", "tailnet"] },
    });
    for (const bad of [
      ["client", "set", "bot", "--scope", "admin"],
      ["client", "set", "bot", "--network", "lan"],
      ["client", "set", "bot"],
      ["client", "set", "missing", "--scope", "read"],
    ])
      await expect(run(bad), bad.join(" ")).resolves.toMatchObject({
        code: 1,
        body: { error: { code: "INVALID_ARGUMENT" } },
      });
  });

  it("lets a read client observe but not dispatch", async () => {
    const api = {
      listHarnesses: vi.fn(async () => ({ harnesses: [] })),
      list: vi.fn(async () => ({ threads: [], nextCursor: null })),
      start: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
    };
    const watchApi = { watch: vi.fn(), watches: vi.fn(async () => ({ watches: [] })) };
    const route = externalClientRouter({
      api: api as unknown as DelegationControlApi,
      watchApi: watchApi as never,
    });
    const call = { client: "viewer", scope: "read", network: "local" } as Parameters<
      typeof route
    >[0];
    await expect(route(call, "/v1/harness/list", {})).resolves.toEqual({ harnesses: [] });
    await expect(
      route(call, "/v1/thread/list", { limit: 1, sort: "created-desc" }),
    ).resolves.toBeDefined();
    await expect(route(call, "/v1/thread/watches", {})).resolves.toBeDefined();
    for (const blocked of [
      "/v1/delegate/start",
      "/v1/thread/send",
      "/v1/thread/cancel",
      "/v1/thread/watch",
    ])
      await expect(route(call, blocked, {}), blocked).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(api.start).not.toHaveBeenCalled();
    expect(watchApi.watch).not.toHaveBeenCalled();
  });

  it("refuses a client on a network it is not allowed, like an unknown token, and answers FORBIDDEN with 403", async () => {
    const registry = new ExternalClientRegistry(file);
    const { token } = await registry.add("bot", { scope: "read" });
    const server = await startExternalClientServer({
      port: 0,
      clients: registry,
      network: "tailnet",
      route: externalClientRouter({
        api: { listHarnesses: async () => ({ harnesses: [] }) } as never,
      }),
    });
    if (!server) throw new Error("listener did not start");
    servers.push(server);
    const post = (route: string) =>
      fetch(new URL(route, server.endpoint), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });

    const refused = await post("/v1/harness/list");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Client token is missing or invalid" },
    });

    await registry.setAccess("bot", { networks: ["local", "tailnet"] });
    expect((await post("/v1/harness/list")).status).toBe(200);
    const forbidden = await post("/v1/delegate/start");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});
