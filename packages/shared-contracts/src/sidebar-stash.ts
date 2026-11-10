import { z } from "zod";

/** Read-only Host method that returns ~/.codex-stash/stash.json for one-time migration. */
export const SIDEBAR_STASH_LEGACY_FILE_METHOD = "codexhost/sidebar-stash/legacy-file";

export const sidebarStashLegacyFileParamsSchema = z.object({}).strict();

export type SidebarStashLegacyFileParams = z.infer<typeof sidebarStashLegacyFileParamsSchema>;

export const sidebarStashLegacyFileResultSchema = z
  .object({
    /** Absolute path the Host tried to read. */
    path: z.string(),
    /** Parsed JSON document, or null when missing/unreadable. */
    document: z.unknown().nullable(),
    /** Null when the read succeeded (including ENOENT → document null). */
    error: z.string().nullable(),
    exists: z.boolean(),
  })
  .strict();

export type SidebarStashLegacyFileResult = z.infer<typeof sidebarStashLegacyFileResultSchema>;
