import type { RendererModuleCdpClient } from "./renderer-loaded-modules.js";

/**
 * Codex fixes the Pet activity stack's viewport height in its Pet chunk (208px, or half the work
 * area while Quick Chat is presented). The chunk is rewritten as it loads so the height comes
 * from the codexhost Pet hook; the native expression stays as the fallback. A chunk without the
 * expression, for example after a Codex update, loads unchanged.
 */
const STACK_HEIGHT_EXPRESSION =
  /(activityStackMaxViewportHeight\$:[\w$]+\(([\w$]+)=>\{let ([\w$]+)=\2\([\w$]+\)\.quickChat;return )([^{};]+)\}/;
const PATCHED_MARKER = "__codexhostPetsStackPatched";

export const AVATAR_OVERLAY_STACK_PATCHED_EXPR = `globalThis.${PATCHED_MARKER} === true`;

export function rewriteAvatarOverlayStackHeightSource(source: string): string | null {
  const match = STACK_HEIGHT_EXPRESSION.exec(source);
  if (!match) return null;
  const [whole, head, , quickChat, nativeHeight] = match;
  const patched = `${head}((h)=>globalThis.__codexhostPetsStackMaxHeight?.(${quickChat},h)??h)(${nativeHeight})}`;
  return `globalThis.${PATCHED_MARKER}=true;${source.slice(0, match.index)}${patched}${source.slice(match.index + whole.length)}`;
}

interface RequestPausedParams {
  readonly requestId: string;
  readonly request: { readonly url: string };
  readonly responseStatusCode?: number;
  readonly responseHeaders?: readonly { name: string; value: string }[];
}

const isRequestPaused = (value: unknown): value is RequestPausedParams =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { requestId?: unknown }).requestId === "string";

/**
 * Intercepts the Pet window's async chunks for the lifetime of this CDP session. The HTTP cache
 * is disabled because cached `app://` scripts bypass Fetch interception.
 */
export async function installAvatarOverlayStackHeightPatch(
  client: RendererModuleCdpClient,
): Promise<void> {
  client.on("Fetch.requestPaused", (params) => {
    if (!isRequestPaused(params)) return;
    void (async () => {
      const { requestId } = params;
      try {
        const body = (await client.command("Fetch.getResponseBody", { requestId })) as {
          body?: string;
          base64Encoded?: boolean;
        };
        const source =
          typeof body.body === "string"
            ? body.base64Encoded
              ? Buffer.from(body.body, "base64").toString("utf8")
              : body.body
            : "";
        const patched = rewriteAvatarOverlayStackHeightSource(source);
        if (patched !== null) {
          await client.command("Fetch.fulfillRequest", {
            requestId,
            responseCode: params.responseStatusCode ?? 200,
            responseHeaders: params.responseHeaders ?? [],
            body: Buffer.from(patched, "utf8").toString("base64"),
          });
          return;
        }
      } catch {
        // Fall through: an unreadable body loads unchanged.
      }
      await client.command("Fetch.continueRequest", { requestId }).catch(() => undefined);
    })();
  });
  await client.command("Network.enable");
  await client.command("Network.setCacheDisabled", { cacheDisabled: true });
  await client.command("Fetch.enable", {
    patterns: [{ urlPattern: "app://*/assets/async/*.js", requestStage: "Response" }],
  });
}
