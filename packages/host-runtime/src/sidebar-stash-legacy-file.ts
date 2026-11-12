import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SIDEBAR_STASH_LEGACY_FILE_METHOD,
  sidebarStashLegacyFileParamsSchema,
  type SidebarStashLegacyFileResult,
} from "@codexhost/shared-contracts";

const RELATIVE_PATH = path.join(".codex-stash", "stash.json");

export function isSidebarStashLegacyFileMethod(method: string): boolean {
  return method === SIDEBAR_STASH_LEGACY_FILE_METHOD;
}

export function sidebarStashLegacyFilePath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, RELATIVE_PATH);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads ~/.codex-stash/stash.json for renderer one-time migration. Never writes. */
export async function readSidebarStashLegacyFile(
  homeDirectory = os.homedir(),
): Promise<SidebarStashLegacyFileResult> {
  const filePath = sidebarStashLegacyFilePath(homeDirectory);
  try {
    const text = await readFile(filePath, "utf8");
    try {
      return {
        path: filePath,
        document: JSON.parse(text) as unknown,
        error: null,
        exists: true,
      };
    } catch (error) {
      return {
        path: filePath,
        document: null,
        error: errorMessage(error),
        exists: true,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: filePath, document: null, error: null, exists: false };
    }
    return {
      path: filePath,
      document: null,
      error: errorMessage(error),
      exists: false,
    };
  }
}

export function parseSidebarStashLegacyFileParams(params: unknown): void {
  const parsed = sidebarStashLegacyFileParamsSchema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new Error("Invalid sidebar stash legacy-file params");
  }
}
