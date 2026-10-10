import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { GitHubCopilotAdapter } from "./adapter.js";

export function createHarnessAdapter(context: HarnessPluginContext): GitHubCopilotAdapter {
  const environment = { ...context.environment };
  return new GitHubCopilotAdapter({
    environment,
    ...(environment.CODEXHOST_COPILOT_COMMAND
      ? { command: environment.CODEXHOST_COPILOT_COMMAND }
      : {}),
  });
}
