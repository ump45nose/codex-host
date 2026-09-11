import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AccountRepository } from "../src/account/account-repository.js";
import { officialAccountEnvironment } from "../src/app-server-host.js";
import { ZCODE_CODEX_ACCOUNT_ID, provisionZcodeCodexAccount } from "../src/zcode-codex-account.js";

describe("ZCode Codex account", () => {
  it("does not create a profile without the launcher opt-in", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-zcode-disabled-"));
    const accounts = new AccountRepository({
      directory: path.join(root, "accounts"),
      defaultAccount: { accountId: "default", codexHome: path.join(root, "default") },
    });
    await accounts.initialize();
    await expect(
      provisionZcodeCodexAccount({ environment: {}, dataDirectory: root, accounts }),
    ).resolves.toBeNull();
    await expect(accounts.list()).resolves.toHaveLength(1);
  });

  it("writes an isolated Responses profile and registers it as a selectable account", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-zcode-enabled-"));
    const accounts = new AccountRepository({
      directory: path.join(root, "accounts"),
      defaultAccount: { accountId: "default", codexHome: path.join(root, "default") },
    });
    await accounts.initialize();
    const account = await provisionZcodeCodexAccount({
      environment: {
        CODEXHOST_ZCODE_ENABLED: "1",
        CODEXHOST_ZCODE_BASE_URL: "http://127.0.0.1:8181",
        CODEXHOST_ZCODE_DEFAULT_MODEL: "glm-5.3",
      },
      dataDirectory: root,
      accounts,
    });
    expect(account).toMatchObject({
      accountId: ZCODE_CODEX_ACCOUNT_ID,
      label: "ZCode Weekend Plan",
    });
    if (!account) throw new Error("ZCode account was not provisioned");
    const configuration = await readFile(path.join(account.codexHome, "config.toml"), "utf8");
    expect(configuration).toContain('model = "glm-5.3"');
    expect(configuration).toContain('base_url = "http://127.0.0.1:8181/v1"');
    expect(configuration).toContain('env_key = "ZCODE_API_KEY"');
    expect(configuration).not.toContain("sk-codexhost-zcode-local");
  });

  it("exposes only the runtime key to the isolated ZCode Codex process", () => {
    const environment = officialAccountEnvironment(
      {
        CODEXHOST_ZCODE_ENABLED: "1",
        CODEXHOST_ZCODE_API_KEY: "proxy-secret",
        ZCODE_PROXY_API_KEY: "proxy-secret",
        UNRELATED: "preserved",
      },
      { accountId: ZCODE_CODEX_ACCOUNT_ID, codexHome: "/managed/zcode" },
    );
    expect(environment).toMatchObject({
      CODEX_HOME: "/managed/zcode",
      ZCODE_API_KEY: "proxy-secret",
      UNRELATED: "preserved",
    });
    expect(environment).not.toHaveProperty("CODEXHOST_ZCODE_API_KEY");
    expect(environment).not.toHaveProperty("ZCODE_PROXY_API_KEY");
  });
});
