import type { SidebarRemoteProject } from "./renderer-sidebar-remote-projects.js";

/** Remote projects Pet Quick Chat can start a thread in, published by the main window. */
export const PETS_REMOTE_PROJECTS_STORAGE_KEY = "codexhost.pets-remote-projects.v1";
/** The Pet's Quick Chat location: absent for this machine, else `hostId\nprojectId`. */
export const PETS_QUICK_CHAT_TARGET_STORAGE_KEY = "codexhost.pets-quick-chat-target.v1";

export interface PetsRemoteProject extends Omit<SidebarRemoteProject, "hostDisplayName"> {
  readonly hostLabel: string;
  readonly hostColor: string | null;
  /** Agents installed on the project's host, Codex first. */
  readonly agents: readonly string[];
}

/** The thread-creation target Codex's Quick Chat accepts for a remote project. */
export interface QuickChatRemoteProjectTarget {
  readonly type: "remoteProject";
  readonly hostId: string;
  readonly projectId: string;
  readonly path: string;
  /** Quick Chat runs in the project directory itself, never in a new worktree. */
  readonly environment: { readonly type: "local" };
  readonly clientThreadId: string;
}

type ReadableStorage = Pick<Storage, "getItem"> | null | undefined;
type WritableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

const targetKey = (project: Pick<PetsRemoteProject, "hostId" | "projectId">): string =>
  `${project.hostId}\n${project.projectId}`;

const isString = (value: unknown): value is string => typeof value === "string";

export function writePetsRemoteProjects(
  projects: readonly PetsRemoteProject[],
  storage: WritableStorage,
): void {
  try {
    const next = JSON.stringify(projects);
    if (storage?.getItem(PETS_REMOTE_PROJECTS_STORAGE_KEY) !== next)
      storage?.setItem(PETS_REMOTE_PROJECTS_STORAGE_KEY, next);
  } catch {}
}

export function readPetsRemoteProjects(storage: ReadableStorage): PetsRemoteProject[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(PETS_REMOTE_PROJECTS_STORAGE_KEY) ?? "");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((raw: unknown): PetsRemoteProject[] => {
      if (typeof raw !== "object" || raw === null) return [];
      const p = raw as Record<string, unknown>;
      if (![p.hostId, p.projectId, p.path, p.label, p.hostLabel].every(isString)) return [];
      return [
        {
          hostId: p.hostId as string,
          projectId: p.projectId as string,
          path: p.path as string,
          label: p.label as string,
          hostLabel: p.hostLabel as string,
          hostColor: isString(p.hostColor) ? p.hostColor : null,
          agents: Array.isArray(p.agents) ? p.agents.filter(isString) : ["codex"],
        },
      ];
    });
  } catch {
    return [];
  }
}

/** The selected remote project, or `null` for this machine (also when it is no longer listed). */
export function readPetsQuickChatTarget(
  storage: ReadableStorage,
  projects: readonly PetsRemoteProject[],
): PetsRemoteProject | null {
  try {
    const stored = storage?.getItem(PETS_QUICK_CHAT_TARGET_STORAGE_KEY);
    return stored ? (projects.find((p) => targetKey(p) === stored) ?? null) : null;
  } catch {
    return null;
  }
}

export function writePetsQuickChatTarget(
  project: Pick<PetsRemoteProject, "hostId" | "projectId"> | null,
  storage: WritableStorage,
): void {
  try {
    if (project) storage?.setItem(PETS_QUICK_CHAT_TARGET_STORAGE_KEY, targetKey(project));
    else storage?.removeItem(PETS_QUICK_CHAT_TARGET_STORAGE_KEY);
  } catch {}
}

const TARGET_HOOK = "__codexhostQuickChatTarget";

/**
 * Serves the Quick Chat target to the rewritten Codex Pet chunk (see desktop-control's
 * avatar-overlay-chunk-patch). Returning `undefined` keeps Codex's own target: this machine,
 * no project.
 */
export function installPetsQuickChatTargetHook(
  win: Window,
  selected: () => PetsRemoteProject | null,
): () => void {
  const state = win as unknown as Record<string, unknown>;
  const hook = (clientThreadId: string): QuickChatRemoteProjectTarget | undefined => {
    const project = selected();
    return project
      ? {
          type: "remoteProject",
          hostId: project.hostId,
          projectId: project.projectId,
          path: project.path,
          environment: { type: "local" },
          clientThreadId,
        }
      : undefined;
  };
  state[TARGET_HOOK] = hook;
  return () => {
    if (state[TARGET_HOOK] === hook) Reflect.deleteProperty(state, TARGET_HOOK);
  };
}
