import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveZcodeProviderConfiguration } from "@codexhost/shared-contracts";

import type { AccountRepositoryLike, CodexAccount } from "./account/account-repository.js";

export const ZCODE_CODEX_ACCOUNT_ID = "zcode";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Builds the isolated Codex CLI configuration that routes Responses requests through ZCode. */
export function zcodeCodexConfigurationToml(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const zcode = resolveZcodeProviderConfiguration(environment);
  return [
    "# Managed by CodexHost. ZCode OAuth credentials remain owned by ZCode Proxy.",
    `model_provider = ${tomlString("zcode")}`,
    `model = ${tomlString(zcode.defaultModel)}`,
    "",
    "[model_providers.zcode]",
    `name = ${tomlString("ZCode Weekend Plan")}`,
    `base_url = ${tomlString(zcode.baseUrl)}`,
    `env_key = ${tomlString("ZCODE_API_KEY")}`,
    `wire_api = ${tomlString("responses")}`,
    "",
  ].join("\n");
}

/** Creates or refreshes the managed ZCode Codex account without touching the user's default home. */
export async function provisionZcodeCodexAccount(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly dataDirectory: string;
  readonly accounts: AccountRepositoryLike;
}): Promise<CodexAccount | null> {
  const zcode = resolveZcodeProviderConfiguration(input.environment);
  if (!zcode.enabled) return null;
  const codexHome = path.join(input.dataDirectory, "codex-homes", ZCODE_CODEX_ACCOUNT_ID);
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const target = path.join(codexHome, "config.toml");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  // The temporary file and atomic rename prevent a partially written profile from starting Codex.
  await writeFile(temporary, zcodeCodexConfigurationToml(input.environment), { mode: 0o600 });
  await rename(temporary, target);
  return input.accounts.upsert({
    accountId: ZCODE_CODEX_ACCOUNT_ID,
    codexHome,
    label: "ZCode Weekend Plan",
  });
}
