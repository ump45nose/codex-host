import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import type {
  HarnessModelCatalog,
  HarnessSessionCapabilities,
  HarnessSessionState,
} from "@codexhost/harness-adapter";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const options = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(object) : [];

export const COPILOT_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
};

export const COPILOT_PERMISSION_MODES = harnessPermissionModeCatalogSchema.parse({
  defaultModeId: "supervised",
  modes: [
    { id: "supervised", label: "Supervised", description: "Ask before using restricted tools" },
    {
      id: "allow-all",
      label: "Allow all",
      description: "Copilot automatically approves tool, path and URL requests",
      dangerous: true,
    },
  ],
});

export function copilotModelRef(id: string) {
  return harnessModelRefSchema.parse({ id: `copilot.${Buffer.from(id).toString("base64url")}` });
}
export function copilotNativeModel(ref: string): string {
  if (!ref.startsWith("copilot.")) throw new Error("Invalid Copilot Model Ref");
  const value = Buffer.from(ref.slice(8), "base64url").toString("utf8");
  if (!value || copilotModelRef(value).id !== ref) throw new Error("Invalid Copilot Model Ref");
  return value;
}

export function copilotConfiguration(opened: Record<string, unknown>): {
  catalog: HarnessModelCatalog;
  state: HarnessSessionState;
  capabilities: HarnessSessionCapabilities;
} {
  const entries = options(opened.configOptions);
  const model = entries.find((entry) => entry.id === "model");
  if (model?.type !== "select") throw new Error("Copilot ACP did not report a Model catalog");
  const models = new Map<string, { ref: ReturnType<typeof copilotModelRef>; label: string }>();
  for (const entry of options(model.options)) {
    const choices = Array.isArray(entry.options) ? options(entry.options) : [entry];
    for (const choice of choices) {
      const id = text(choice.value),
        label = text(choice.name);
      if (id && label && !models.has(id)) models.set(id, { ref: copilotModelRef(id), label });
    }
  }
  const currentId = text(model.currentValue);
  const current = models.get(currentId);
  if (!current) throw new Error("Copilot ACP did not report a selectable current Model");
  const thought = entries.find(
    (entry) => entry.id === "reasoning_effort" && entry.type === "select",
  );
  const thinkingOptions = options(thought?.options).flatMap((entry) => {
    const value = harnessThinkingOptionIdSchema.safeParse(entry.value);
    if (!value.success || !text(entry.name)) return [];
    // Copilot ACP 1.0.89 supplies raw lowercase IDs as names. Preserve native
    // labels when provided, but make the raw IDs readable in the Desktop picker.
    const nativeLabel = text(entry.name);
    const label =
      nativeLabel === value.data
        ? (({ xhigh: "Extra High" } as Record<string, string>)[value.data] ??
          value.data.slice(0, 1).toUpperCase() + value.data.slice(1))
        : nativeLabel;
    return [{ id: value.data, label }];
  });
  const currentThought = thinkingOptions.find(({ id }) => id === thought?.currentValue);
  const mode = entries.find((entry) => entry.id === "allow_all" && entry.type === "select");
  const selectableMode =
    options(mode?.options).some((entry) => entry.value === "on") &&
    options(mode?.options).some((entry) => entry.value === "off");
  const effectivePermissionModeId =
    selectableMode && (mode?.currentValue === "on" || mode?.currentValue === "off")
      ? harnessPermissionModeIdSchema.parse(mode.currentValue === "on" ? "allow-all" : "supervised")
      : undefined;
  const catalog = harnessModelCatalogSchema.parse({
    models: [...models.values()].map((entry) => ({
      ...entry,
      // Native reasoning choices are per Model. Only the current Model was
      // inspected in this ACP response; never claim these levels for the rest.
      ...(entry.ref.id === current.ref.id && thinkingOptions.length
        ? { supportedThinkingOptionIds: thinkingOptions.map(({ id }) => id) }
        : {}),
    })),
    defaultModel: current.ref,
    thinkingOptions,
    ...(currentThought ? { defaultThinkingOptionId: currentThought.id } : {}),
  });
  return {
    catalog,
    state: {
      effectiveModel: current.ref,
      resolvedModelLabel: current.label,
      availableThinkingOptions: thinkingOptions,
      ...(currentThought ? { effectiveThinkingOptionId: currentThought.id } : {}),
      ...(effectivePermissionModeId ? { effectivePermissionModeId } : {}),
    },
    capabilities: {
      ...COPILOT_CAPABILITIES,
      configuration: {
        ...COPILOT_CAPABILITIES.configuration,
        selectThinkingOption: thinkingOptions.length > 0,
        selectPermissionMode: Boolean(effectivePermissionModeId),
      },
    },
  };
}
