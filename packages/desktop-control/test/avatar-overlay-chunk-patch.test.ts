import { describe, expect, it } from "vitest";
import { rewriteAvatarOverlayChunkSource } from "../src/avatar-overlay-chunk-patch.js";

/** Minified shapes of the two Codex Pet chunk expressions codexhost rewrites. */
const STACK =
  "activityStackMaxViewportHeight$:a(e=>{let t=e(i).quickChat;return null==t?d.e3:Math.max(d.YMX,t.workArea.height/2-d.Zam-d.rqb)})";
const QUICK_CHAT =
  'p=await (0,b.Nw)({scope:D,turnTrigger:"avatar_quick_chat",threadSource:"avatar_quick_chat",model:void 0,prompt:e,target:{type:"projectless",clientThreadId:t},thinking:void 0})';

describe("rewriteAvatarOverlayChunkSource", () => {
  it("routes the stack height and the Quick Chat target through codexhost hooks", () => {
    const patched = rewriteAvatarOverlayChunkSource(`${STACK};${QUICK_CHAT}`) ?? "";
    expect(patched.startsWith("globalThis.__codexhostPetsStackPatched=true;")).toBe(true);
    expect(patched).toContain(
      "((h)=>globalThis.__codexhostPetsStackMaxHeight?.(t,h)??h)(null==t?d.e3:",
    );
    expect(patched).toContain(
      'target:(globalThis.__codexhostQuickChatTarget?.(t)??{type:"projectless",clientThreadId:t})',
    );
  });

  it("leaves other projectless targets and unrelated chunks unchanged", () => {
    const other = 'threadSource:"other",target:{type:"projectless",clientThreadId:t}';
    expect(rewriteAvatarOverlayChunkSource(other)).toBeNull();
  });
});
