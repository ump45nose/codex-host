import type { HarnessSessionState } from "@codexhost/harness-adapter";
import type { CopilotClient } from "./acp-client.js";
import {
  copilotConfiguration,
  copilotNativeModel,
  type CopilotContextTier,
} from "./configuration.js";

/** Restore only confirmed native settings before publishing a replacement client. */
export async function restoreCopilotClient(
  next: CopilotClient,
  cwd: string,
  sessionId: string | undefined,
  contextTier: CopilotContextTier,
  previous: HarnessSessionState,
  modelId?: string,
) {
  await next.initialize();
  let response = await next.open(cwd, sessionId);
  if (sessionId && response.sessionId && response.sessionId !== sessionId)
    throw new Error("Copilot restored a different Session ID");
  const nativeSessionId = sessionId ?? response.sessionId;
  if (typeof nativeSessionId !== "string" || !nativeSessionId)
    throw new Error("Copilot replacement omitted Session ID");
  const desiredModel =
    modelId ?? (previous.effectiveModel && copilotNativeModel(previous.effectiveModel.id));
  if (desiredModel) response = await next.setConfigOption(nativeSessionId, "model", desiredModel);
  let config = copilotConfiguration(response, contextTier);
  if (
    desiredModel &&
    (!config.state.effectiveModel ||
      copilotNativeModel(config.state.effectiveModel.id) !== desiredModel)
  )
    throw new Error("Copilot did not confirm restored Model");
  if (
    previous.effectiveThinkingOptionId &&
    config.state.availableThinkingOptions?.some(
      ({ id }) => id === previous.effectiveThinkingOptionId,
    )
  ) {
    response = await next.setConfigOption(
      nativeSessionId,
      "reasoning_effort",
      previous.effectiveThinkingOptionId,
    );
    config = copilotConfiguration(response, contextTier);
    if (config.state.effectiveThinkingOptionId !== previous.effectiveThinkingOptionId)
      throw new Error("Copilot did not confirm restored Thinking option");
  }
  if (
    previous.effectivePermissionModeId &&
    config.capabilities.configuration.selectPermissionMode
  ) {
    response = await next.setConfigOption(
      nativeSessionId,
      "allow_all",
      previous.effectivePermissionModeId === "allow-all" ? "on" : "off",
    );
    config = copilotConfiguration(response, contextTier);
    if (config.state.effectivePermissionModeId !== previous.effectivePermissionModeId)
      throw new Error("Copilot did not confirm restored Permission Mode");
  }
  if (
    desiredModel &&
    (!config.state.effectiveModel ||
      copilotNativeModel(config.state.effectiveModel.id) !== desiredModel)
  )
    throw new Error("Copilot changed Model while restoring configuration");
  return { config, nativeSessionId };
}
