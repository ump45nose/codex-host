import { commandInvocation, resolveHarnessExecutable } from "@codexhost/harness-discovery";

import type { CopilotContextTier } from "./configuration.js";

export function copilotInvocation(
  environment: NodeJS.ProcessEnv,
  command?: string,
  contextTier?: CopilotContextTier,
) {
  const resolution = resolveHarnessExecutable(
    {
      id: "github-copilot-cli",
      command: "copilot",
      commandEnvironmentVariable: "CODEXHOST_COPILOT_COMMAND",
      installRoots: {
        posix: ["~/.local/bin", "/usr/local/bin", "/opt/homebrew/bin"],
        windows: ["${APPDATA}/npm", "${LOCALAPPDATA}/Microsoft/WinGet/Links"],
      },
    },
    { environment, ...(command ? { command } : {}) },
  );
  if (!resolution) throw new Error("GitHub Copilot CLI is not installed");
  return commandInvocation(
    resolution.executable,
    ["--acp", "--stdio", ...(contextTier ? ["--context", contextTier] : [])],
    environment,
  );
}
