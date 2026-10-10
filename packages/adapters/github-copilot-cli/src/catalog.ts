import { harnessModelCatalogSchema } from "@codexhost/shared-contracts";
import type { CopilotClient } from "./acp-client.js";
import { copilotConfiguration, copilotNativeModel } from "./configuration.js";

/** Query model-specific native reasoning choices in a disposable inspection session. */
export async function inspectCopilotCatalog(
  client: CopilotClient,
  opened: Record<string, unknown>,
) {
  const original = copilotConfiguration(opened);
  const defaultModel = original.catalog.defaultModel;
  if (!defaultModel) throw new Error("Copilot inspection omitted default Model");
  const originalModelId = copilotNativeModel(defaultModel.id);
  const sessionId = opened.sessionId;
  if (typeof sessionId !== "string") throw new Error("Copilot inspection omitted Session ID");
  const models = new Map(original.catalog.models.map((model) => [model.ref.id, model]));
  const thinking = new Map(original.catalog.thinkingOptions.map((option) => [option.id, option]));
  const nativeIds = [
    ...new Set(original.catalog.models.map(({ ref }) => copilotNativeModel(ref.id))),
  ];
  try {
    for (const id of nativeIds) {
      if (id === originalModelId) continue;
      const response = await client.setConfigOption(sessionId, "model", id);
      const configuration = copilotConfiguration(response);
      const confirmedModel = configuration.state.effectiveModel;
      if (!confirmedModel || copilotNativeModel(confirmedModel.id) !== id)
        throw new Error("Copilot did not confirm inspected Model");
      for (const option of configuration.catalog.thinkingOptions) thinking.set(option.id, option);
      for (const model of configuration.catalog.models) {
        if (copilotNativeModel(model.ref.id) === id) models.set(model.ref.id, model);
      }
    }
  } finally {
    await client.setConfigOption(sessionId, "model", originalModelId);
    if (original.state.effectiveThinkingOptionId)
      await client.setConfigOption(
        sessionId,
        "reasoning_effort",
        original.state.effectiveThinkingOptionId,
      );
  }
  const catalog = harnessModelCatalogSchema.parse({
    ...original.catalog,
    models: [...models.values()],
    thinkingOptions: [...thinking.values()],
  });
  return {
    ...original,
    catalog,
    capabilities: {
      ...original.capabilities,
      configuration: {
        ...original.capabilities.configuration,
        selectThinkingOption: thinking.size > 0,
      },
    },
  };
}
