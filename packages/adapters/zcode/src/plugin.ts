import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { ZCodeAdapter } from "./zcode-adapter.js";

export const ZCODE_COMMAND_ENV = "CODEXHOST_ZCODE_COMMAND";

/** Constructs the standalone ZCode Harness plugin. */
export function createHarnessAdapter(context: HarnessPluginContext): ZCodeAdapter {
  const environment = { ...context.environment };
  return new ZCodeAdapter({
    ...(environment[ZCODE_COMMAND_ENV] ? { command: environment[ZCODE_COMMAND_ENV] } : {}),
    environment,
  });
}
