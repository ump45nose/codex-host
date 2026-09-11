import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

export interface ZCodeModelRef {
  providerId: string;
  modelId: string;
}

interface ZCodeModelEntry {
  label?: unknown;
  ref?: unknown;
  reasoning?: unknown;
}

/** Encodes the provider/model pair into a transport-safe opaque Harness reference. */
export function encodeZCodeModelRef(model: ZCodeModelRef): HarnessModelRef {
  const payload = Buffer.from(JSON.stringify([model.providerId, model.modelId])).toString(
    "base64url",
  );
  return harnessModelRefSchema.parse({ id: `zcode-model-v1.${payload}` });
}

/** Decodes and validates a ZCode model reference selected by the Host UI. */
export function decodeZCodeModelRef(ref: HarnessModelRef): ZCodeModelRef {
  const prefix = "zcode-model-v1.";
  if (!ref.id.startsWith(prefix)) throw new Error("Invalid ZCode Model reference");
  const value: unknown = JSON.parse(
    Buffer.from(ref.id.slice(prefix.length), "base64url").toString(),
  );
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((part) => typeof part !== "string" || part.length === 0)
  ) {
    throw new Error("Invalid ZCode Model reference payload");
  }
  return { providerId: value[0] as string, modelId: value[1] as string };
}

/** Converts a native thought-level string into a stable Host option identity. */
export function encodeZCodeThinkingOption(value: string): HarnessThinkingOptionId {
  return harnessThinkingOptionIdSchema.parse(
    `zcode-thinking-v1.${Buffer.from(value).toString("base64url")}`,
  );
}

/** Decodes a Host thought-level identity before sending it to ZCode. */
export function decodeZCodeThinkingOption(id: HarnessThinkingOptionId): string {
  const prefix = "zcode-thinking-v1.";
  if (!id.startsWith(prefix)) throw new Error("Invalid ZCode Thinking option");
  const value = Buffer.from(id.slice(prefix.length), "base64url").toString();
  if (!value) throw new Error("Invalid ZCode Thinking option payload");
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Projects the model and reasoning settings returned by the native ZCode app-server. */
export function zcodeModelCatalog(snapshot: unknown): HarnessModelCatalog {
  const root = record(snapshot);
  const settings = record(root?.settings);
  const modelState = record(settings?.model);
  const thoughtState = record(settings?.thoughtLevel);
  const available = Array.isArray(modelState?.available) ? modelState.available : [];
  const thoughtEntries = Array.isArray(thoughtState?.available) ? thoughtState.available : [];
  const thinkingOptions = thoughtEntries.flatMap((entry) => {
    const candidate = record(entry);
    const value = typeof candidate?.value === "string" ? candidate.value : null;
    if (!value) return [];
    return [{ id: encodeZCodeThinkingOption(value), label: String(candidate?.label ?? value) }];
  });
  const models = available.flatMap((entry) => {
    const candidate = entry as ZCodeModelEntry;
    const native = record(candidate.ref);
    if (typeof native?.providerId !== "string" || typeof native.modelId !== "string") return [];
    return [
      {
        ref: encodeZCodeModelRef({ providerId: native.providerId, modelId: native.modelId }),
        label: typeof candidate.label === "string" ? candidate.label : native.modelId,
        ...(thinkingOptions.length > 0
          ? { supportedThinkingOptionIds: thinkingOptions.map(({ id }) => id) }
          : {}),
      },
    ];
  });
  const current = record(modelState?.current);
  const currentRef =
    typeof current?.providerId === "string" && typeof current.modelId === "string"
      ? encodeZCodeModelRef({ providerId: current.providerId, modelId: current.modelId })
      : undefined;
  const currentThought =
    typeof thoughtState?.current === "string"
      ? encodeZCodeThinkingOption(thoughtState.current)
      : undefined;
  return harnessModelCatalogSchema.parse({
    models,
    ...(currentRef ? { defaultModel: currentRef } : {}),
    thinkingOptions,
    ...(currentThought ? { defaultThinkingOptionId: currentThought } : {}),
  });
}
