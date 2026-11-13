import type { RendererModuleCdpClient } from "./renderer-loaded-modules.js";

/**
 * Codex fixes two Pet behaviors in its Pet chunk that codexhost makes configurable, so the chunk
 * is rewritten as it loads. Each rewrite keeps the native value as the fallback, and a chunk
 * without the expected expression (for example after a Codex update) loads unchanged.
 *
 * - The activity stack's viewport height (208px, or half the work area while Quick Chat is
 *   presented) comes from `__codexhostPetsStackMaxHeight`.
 * - Quick Chat creates every thread on this machine without a project; the target comes from
 *   `__codexhostQuickChatTarget`, which may name a remote project instead.
 */
const STACK_HEIGHT_EXPRESSION =
  /(activityStackMaxViewportHeight\$:[\w$]+\(([\w$]+)=>\{let ([\w$]+)=\2\([\w$]+\)\.quickChat;return )([^{};]+)\}/;
const QUICK_CHAT_TARGET_EXPRESSION =
  /(threadSource:"avatar_quick_chat",[^;]{0,300}?target:)\{type:"projectless",clientThreadId:([\w$]+)\}/;
const PATCHED_MARKER = "__codexhostPetsStackPatched";

export const AVATAR_OVERLAY_STACK_PATCHED_EXPR = `globalThis.${PATCHED_MARKER} === true`;

export function rewriteAvatarOverlayChunkSource(source: string): string | null {
  let patched = source;
  const stack = STACK_HEIGHT_EXPRESSION.exec(patched);
  if (stack) {
    const [whole, head, , quickChat, nativeHeight] = stack;
    patched = `globalThis.${PATCHED_MARKER}=true;${patched.slice(0, stack.index)}${head}((h)=>globalThis.__codexhostPetsStackMaxHeight?.(${quickChat},h)??h)(${nativeHeight})}${patched.slice(stack.index + whole.length)}`;
  }
  const target = QUICK_CHAT_TARGET_EXPRESSION.exec(patched);
  if (target) {
    const [whole, head, clientThreadId] = target;
    patched = `${patched.slice(0, target.index)}${head}(globalThis.__codexhostQuickChatTarget?.(${clientThreadId})??{type:"projectless",clientThreadId:${clientThreadId}})${patched.slice(target.index + whole.length)}`;
  }
  return patched === source ? null : patched;
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
export async function installAvatarOverlayChunkPatch(
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
        const patched = rewriteAvatarOverlayChunkSource(source);
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
