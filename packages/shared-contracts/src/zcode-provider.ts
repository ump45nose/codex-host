/** Environment switch that enables the managed ZCode Provider integration. */
export const ZCODE_PROVIDER_ENABLED_ENV = "CODEXHOST_ZCODE_ENABLED";
/** Optional ZCode Proxy endpoint. The value may include or omit the `/v1` suffix. */
export const ZCODE_PROVIDER_BASE_URL_ENV = "CODEXHOST_ZCODE_BASE_URL";
/** Optional proxy access key; the OAuth credential owned by ZCode Proxy is never read. */
export const ZCODE_PROVIDER_API_KEY_ENV = "CODEXHOST_ZCODE_API_KEY";
/** Comma-separated Model IDs advertised to Codex and OpenCode. */
export const ZCODE_PROVIDER_MODELS_ENV = "CODEXHOST_ZCODE_MODELS";
/** Preferred Model ID for newly created ZCode-backed sessions. */
export const ZCODE_PROVIDER_DEFAULT_MODEL_ENV = "CODEXHOST_ZCODE_DEFAULT_MODEL";
/** Child-process-only API key consumed by Codex and OpenCode Provider configuration. */
export const ZCODE_RUNTIME_API_KEY_ENV = "ZCODE_API_KEY";

export const DEFAULT_ZCODE_PROVIDER_BASE_URL = "http://127.0.0.1:8080/v1";
export const DEFAULT_ZCODE_PROVIDER_MODELS = Object.freeze([
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "glm-5-turbo",
  "glm-5v-turbo",
  "glm-4.7",
  "glm-4.6",
  "glm-4.6v",
  "glm-4.5-air",
] as const);

export interface ZcodeProviderConfiguration {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly string[];
  readonly defaultModel: string;
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** Resolves one bounded, secret-safe ZCode Provider configuration from launcher environment. */
export function resolveZcodeProviderConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ZcodeProviderConfiguration {
  const enabledValue = environment[ZCODE_PROVIDER_ENABLED_ENV]?.trim().toLowerCase();
  const enabled =
    enabledValue !== undefined && !["", "0", "false", "no", "off"].includes(enabledValue);
  const baseUrl = normalizeZcodeBaseUrl(
    environment[ZCODE_PROVIDER_BASE_URL_ENV] ?? DEFAULT_ZCODE_PROVIDER_BASE_URL,
  );
  const configuredModels = (environment[ZCODE_PROVIDER_MODELS_ENV] ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(
      (model, index, models) => MODEL_ID_PATTERN.test(model) && models.indexOf(model) === index,
    );
  const models =
    configuredModels.length > 0 ? configuredModels : [...DEFAULT_ZCODE_PROVIDER_MODELS];
  const requestedDefault = environment[ZCODE_PROVIDER_DEFAULT_MODEL_ENV]?.trim();
  const defaultModel =
    requestedDefault && MODEL_ID_PATTERN.test(requestedDefault)
      ? requestedDefault
      : (models[0] ?? DEFAULT_ZCODE_PROVIDER_MODELS[0]);
  const completeModels = models.includes(defaultModel) ? models : [defaultModel, ...models];
  return {
    enabled,
    baseUrl,
    // ZCode Proxy accepts any non-empty key when proxy authentication is disabled.
    apiKey:
      environment[ZCODE_PROVIDER_API_KEY_ENV] ??
      environment.ZCODE_PROXY_API_KEY ??
      "sk-codexhost-zcode-local",
    models: completeModels,
    defaultModel,
  };
}

/** Normalizes the proxy root to the OpenAI-compatible `/v1` endpoint. */
function normalizeZcodeBaseUrl(value: string): string {
  const match = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/u.exec(value.trim());
  const protocol = match?.[1];
  const authority = match?.[2];
  if (!protocol || !authority || authority.includes("@")) {
    throw new Error("ZCode Provider base URL must be an uncredentialed HTTP(S) URL");
  }
  const pathname = (match?.[3] ?? "").replace(/\/+$/u, "").replace(/\/v1$/u, "");
  return `${protocol}://${authority}${pathname}/v1`;
}
