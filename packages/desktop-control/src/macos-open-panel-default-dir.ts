import { execFile as execFileCallback } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

export const DEFAULT_MACOS_CODEX_BUNDLE_ID = "com.openai.codex";
export const DEFAULT_MACOS_PROJECT_PERSONAL_REPOS_SUBPATH = path.join(
  "Developer",
  "Repos",
  "Personal",
);

const OSASCRIPT_TIMEOUT_MS = 2_000;

const JXA_SET_OPEN_PANEL_ROOT_SCRIPT = `
ObjC.import("Foundation");
function run(argv) {
  var targetPath = argv[0];
  var domain = argv[1];
  var url = $.NSURL.fileURLWithPathIsDirectory($(targetPath), true);
  var err = Ref();
  var bookmark = url.bookmarkDataWithOptionsIncludingResourceValuesForKeysRelativeToURLError(0, $(), $(), err);
  if (!bookmark || bookmark.isNil()) return "failed";
  var defaults = $.NSUserDefaults.alloc.initWithSuiteName($(domain));
  defaults.setObjectForKey(bookmark, $("NSOSPLastRootDirectory"));
  defaults.setObjectForKey($(targetPath), $("NSNavLastRootDirectory"));
  defaults.synchronize;
  return "ok";
}
`.trim();

const CLAIM_OPEN_PANEL_SYNC_NONCE_EXPRESSION = `(() => {
  const current =
    typeof window.__codexhostMacOpenPanelResetNonceV1 === "number" &&
    Number.isFinite(window.__codexhostMacOpenPanelResetNonceV1)
      ? window.__codexhostMacOpenPanelResetNonceV1
      : 1;
  if (window.__codexhostMacOpenPanelSyncedNonceV1 === current) return null;
  window.__codexhostMacOpenPanelSyncedNonceV1 = current;
  return current;
})()`;

export interface RendererEvaluator {
  evaluate<T>(expression: string): Promise<T>;
}

export interface SyncMacOsOpenPanelDefaultDirectoryOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly subpath?: string;
  readonly bundleId?: string;
  readonly runOsascript?: (
    script: string,
    targetDirectory: string,
    bundleId: string,
  ) => Promise<void>;
}

async function defaultRunOsascript(
  script: string,
  targetDirectory: string,
  bundleId: string,
): Promise<void> {
  await execFileAsync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script, targetDirectory, bundleId],
    { timeout: OSASCRIPT_TIMEOUT_MS },
  );
}

export async function syncMacOsOpenPanelDefaultDirectory(
  renderer: RendererEvaluator,
  options: SyncMacOsOpenPanelDefaultDirectoryOptions = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return false;

  try {
    const claimedNonce = await renderer.evaluate<number | null>(
      CLAIM_OPEN_PANEL_SYNC_NONCE_EXPRESSION,
    );
    if (claimedNonce === null) return false;

    const homeDirectory = options.homeDirectory ?? os.homedir();
    const subpath = options.subpath ?? DEFAULT_MACOS_PROJECT_PERSONAL_REPOS_SUBPATH;
    const targetDirectory = path.join(homeDirectory, subpath);
    const directoryStats = await stat(targetDirectory).catch(() => null);
    if (!directoryStats?.isDirectory()) return false;

    const bundleId = options.bundleId ?? DEFAULT_MACOS_CODEX_BUNDLE_ID;
    const runOsascript = options.runOsascript ?? defaultRunOsascript;
    await runOsascript(JXA_SET_OPEN_PANEL_ROOT_SCRIPT, targetDirectory, bundleId);
    return true;
  } catch {
    return false;
  }
}
