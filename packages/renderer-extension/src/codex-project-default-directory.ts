import { loadCodexNativeServices } from "./codex-native-services.js";

export const DEFAULT_PROJECT_PERSONAL_REPOS_SUBPATH = "Developer/Repos/Personal";

export const ACCOUNT_SCOPED_GLOBAL_STATE_KEYS = [
  "local-projects",
  "selected-project",
  "project-appearances",
  "pinned-thread-ids",
  "pinned-project-ids",
  "sidebar-project-thread-orders",
  "sidebar-thread-metadata",
  "thread-project-assignments",
  "thread-workspace-root-hints",
  "projectless-thread-ids",
  "remote-projects",
  "project-order",
  "connection-group-order",
  "remote-cwds-by-host-and-workspace",
] as const;

const WRAPPED_WORKSPACE_FILES_SYMBOL = Symbol.for(
  "codexhost.workspaceFilesDefaultDirectoryWrappedV1",
);
const WRAPPED_PROJECTS_SYMBOL = Symbol.for("codexhost.projectsDeduplicationWrappedV1");
const DISPOSE_SYMBOL: symbol =
  (Symbol as { readonly dispose?: symbol }).dispose ?? Symbol.for("Symbol.dispose");

const OPEN_PANEL_RESET_MESSAGE_TYPES = new Set([
  "workspace-root-option-picked",
  "workspace-root-option-added",
  "workspace-root-option-add-canceled",
]);

const ACCOUNT_SCOPED_REFRESH_MESSAGE_TYPES = new Set([
  "persisted-atom-sync",
  "codex-app-server-initialized",
  "codex-app-server-connection-changed",
]);

export interface BrowseDirectoryRequest {
  readonly hostId?: string;
  readonly directoryPath?: string | null;
  readonly directoriesOnly?: boolean;
  readonly [key: string]: unknown;
}

export interface BrowseDirectoryResponse {
  readonly directoryPath: string;
  readonly parentPath?: string | null;
  readonly entries?: readonly unknown[];
  readonly [key: string]: unknown;
}

export type NativeDisposablePromise<T> = Promise<T> & {
  [Symbol.dispose]?: () => void;
};

export interface NativeWorkspaceFiles {
  browseDirectory(params: BrowseDirectoryRequest): NativeDisposablePromise<BrowseDirectoryResponse>;
  readonly [key: string]: unknown;
}

export interface NativeLocalProjectEntry {
  readonly id: string;
  readonly name: string;
  readonly rootPaths: readonly string[];
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly [key: string]: unknown;
}

export interface CreateLocalProjectRequest {
  readonly name?: string;
  readonly sources: readonly string[];
  readonly setActive?: boolean;
  readonly appearance?: unknown;
  readonly initializeDefaultWorkspaceGitRepository?: boolean;
  readonly [key: string]: unknown;
}

export interface CreateLocalProjectResponse {
  readonly projectId: string;
  readonly rootPaths: readonly string[];
}

export interface NativeProjectsService {
  createLocal(
    params: CreateLocalProjectRequest,
  ): NativeDisposablePromise<CreateLocalProjectResponse | null>;
  removeLocal?(projectId: string): NativeDisposablePromise<unknown>;
  setProjectOrder?(order: readonly string[]): NativeDisposablePromise<unknown>;
  readonly [key: string]: unknown;
}

export interface NativeProjectCatalogService {
  readLocalProjects?(): NativeDisposablePromise<
    Record<string, NativeLocalProjectEntry> | undefined
  >;
  readSelection?(): NativeDisposablePromise<
    { readonly type: string; readonly projectId: string } | null | undefined
  >;
}

export interface NativeProjectPresentationService {
  readOrder?(): NativeDisposablePromise<readonly string[] | undefined>;
}

export interface NativeApplicationStateService {
  read?(key: string): NativeDisposablePromise<{ readonly value: unknown } | undefined>;
  write?(key: string, value: unknown): NativeDisposablePromise<{ readonly success?: boolean }>;
}

export interface NativeThreadProjectAssignmentsService {
  readMemberships?(): NativeDisposablePromise<{
    readonly assignments?: Record<
      string,
      { readonly projectKind?: string; readonly projectId?: string; readonly hostId?: string }
    >;
    readonly projectlessThreadIds?: readonly string[];
  }>;
  setAssignment?(params: {
    readonly threadId: string;
    readonly assignment: {
      readonly projectKind: string;
      readonly projectId: string;
      readonly hostId?: string;
    } | null;
  }): NativeDisposablePromise<unknown>;
}

export interface NativeQueryCacheService {
  invalidateQueryCache?(params: {
    readonly queryKey: readonly unknown[];
    readonly reset?: boolean;
  }): NativeDisposablePromise<unknown>;
}

export interface NativeWorkspaceFilesServices {
  workspaceFiles: NativeWorkspaceFiles;
  projects?: NativeProjectsService;
  projectCatalog?: NativeProjectCatalogService;
  projectPresentation?: NativeProjectPresentationService;
  applicationState?: NativeApplicationStateService;
  threadProjectAssignments?: NativeThreadProjectAssignmentsService;
  queryCache?: NativeQueryCacheService;
}

export interface CodexProjectDefaultDirectoryHandle {
  dispose(): void;
}

declare global {
  interface Window {
    __codexhostMacOpenPanelResetNonceV1?: number;
    __codexhostMacOpenPanelSyncedNonceV1?: number;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNativeWorkspaceFilesServices(
  value: unknown,
): value is NativeWorkspaceFilesServices {
  if (!isRecord(value) || !Object.hasOwn(value, "workspaceFiles")) return false;
  const workspaceFiles = value.workspaceFiles as
    NativeWorkspaceFilesServices["workspaceFiles"] | null | undefined;
  return (
    (typeof workspaceFiles === "object" || typeof workspaceFiles === "function") &&
    workspaceFiles !== null &&
    typeof workspaceFiles.browseDirectory === "function"
  );
}

export function resolvePreferredProjectParentDirectory(
  homeDirectoryPath: string,
  subpath: string = DEFAULT_PROJECT_PERSONAL_REPOS_SUBPATH,
): string | null {
  const trimmedHome = homeDirectoryPath.trim().replace(/\/+$/u, "");
  const trimmedSubpath = subpath.trim().replace(/^\/+|\/+$/gu, "");
  if (!trimmedHome.startsWith("/") || trimmedSubpath.length === 0) return null;
  const targetSuffix = `/${trimmedSubpath}`;
  if (trimmedHome.endsWith(targetSuffix)) return trimmedHome;
  return `${trimmedHome}${targetSuffix}`;
}

function isDefaultDirectoryBrowseRequest(params: unknown): params is BrowseDirectoryRequest {
  if (!isRecord(params)) return false;
  const directoryPath = params.directoryPath;
  return (
    directoryPath === null ||
    directoryPath === undefined ||
    (typeof directoryPath === "string" && directoryPath.trim().length === 0)
  );
}

function isBrowseDirectoryResponse(value: unknown): value is BrowseDirectoryResponse {
  return (
    isRecord(value) &&
    typeof value.directoryPath === "string" &&
    value.directoryPath.trim().length > 0
  );
}

function unwrapWorkspaceFiles(workspaceFiles: NativeWorkspaceFiles): NativeWorkspaceFiles {
  const unwrapped = Reflect.get(workspaceFiles as object, WRAPPED_WORKSPACE_FILES_SYMBOL) as
    NativeWorkspaceFiles | undefined;
  return unwrapped ?? workspaceFiles;
}

function attachDisposable<T>(promise: Promise<T>, dispose: () => void): NativeDisposablePromise<T> {
  const disposablePromise = promise as NativeDisposablePromise<T>;
  Object.defineProperty(disposablePromise, DISPOSE_SYMBOL, {
    value: dispose,
    configurable: true,
  });
  return disposablePromise;
}

export function wrapWorkspaceFilesWithDefaultDirectory(
  workspaceFiles: NativeWorkspaceFiles,
  subpath: string = DEFAULT_PROJECT_PERSONAL_REPOS_SUBPATH,
): NativeWorkspaceFiles {
  const target = unwrapWorkspaceFiles(workspaceFiles);
  const preferredDirectoryByHost = new Map<string, string>();

  const callTargetBrowse = (
    params: BrowseDirectoryRequest,
  ): NativeDisposablePromise<BrowseDirectoryResponse> =>
    Reflect.apply(target.browseDirectory, target, [
      params,
    ]) as NativeDisposablePromise<BrowseDirectoryResponse>;

  const browseDirectory = (
    params: BrowseDirectoryRequest,
  ): NativeDisposablePromise<BrowseDirectoryResponse> => {
    if (!isDefaultDirectoryBrowseRequest(params)) {
      return callTargetBrowse(params);
    }

    const activeDisposables = new Set<() => void>();
    const invokeBrowse = async (
      requestParams: BrowseDirectoryRequest,
    ): Promise<BrowseDirectoryResponse> => {
      const request = callTargetBrowse(requestParams);
      const requestDispose = Reflect.get(request as object, DISPOSE_SYMBOL);
      const disposeOne =
        typeof requestDispose === "function"
          ? () => {
              try {
                Reflect.apply(requestDispose, request, []);
              } catch {
                // Ignore duplicate or post-settlement RPC disposal errors.
              }
            }
          : undefined;
      if (disposeOne) activeDisposables.add(disposeOne);
      try {
        return await request;
      } finally {
        if (disposeOne) {
          activeDisposables.delete(disposeOne);
          disposeOne();
        }
      }
    };

    const hostKey =
      typeof params.hostId === "string" && params.hostId.trim().length > 0
        ? params.hostId.trim()
        : "local";

    const resolvedPromise = (async (): Promise<BrowseDirectoryResponse> => {
      const cachedPreferredPath = preferredDirectoryByHost.get(hostKey);
      if (cachedPreferredPath) {
        try {
          const cachedListing = await invokeBrowse({
            ...params,
            directoryPath: cachedPreferredPath,
          });
          if (isBrowseDirectoryResponse(cachedListing)) {
            return cachedListing;
          }
        } catch {
          preferredDirectoryByHost.delete(hostKey);
        }
      }

      const homeListing = await invokeBrowse(params);
      if (!isBrowseDirectoryResponse(homeListing)) {
        return homeListing;
      }

      const preferredPath = resolvePreferredProjectParentDirectory(
        homeListing.directoryPath,
        subpath,
      );
      if (!preferredPath || preferredPath === homeListing.directoryPath) {
        return homeListing;
      }

      try {
        const preferredListing = await invokeBrowse({
          ...params,
          directoryPath: preferredPath,
        });
        if (isBrowseDirectoryResponse(preferredListing)) {
          preferredDirectoryByHost.set(hostKey, preferredListing.directoryPath);
          return preferredListing;
        }
      } catch {
        // Fall back to the host's default home directory when ~/Developer/Repos/Personal is absent.
      }
      return homeListing;
    })();

    return attachDisposable(resolvedPromise, () => {
      for (const disposeOne of [...activeDisposables]) {
        activeDisposables.delete(disposeOne);
        disposeOne();
      }
    });
  };

  return new Proxy(target, {
    get(currentTarget, prop) {
      if (prop === WRAPPED_WORKSPACE_FILES_SYMBOL) return currentTarget;
      if (prop === "browseDirectory") return browseDirectory;
      return Reflect.get(currentTarget, prop, currentTarget);
    },
  });
}

function normalizeSingleRootPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/u, "");
}

export function normalizeProjectRootPaths(paths: readonly string[] | undefined): string[] {
  if (!Array.isArray(paths)) return [];
  const normalized: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== "string") continue;
    const clean = normalizeSingleRootPath(entry);
    if (clean.length > 0 && !normalized.includes(clean)) {
      normalized.push(clean);
    }
  }
  return normalized;
}

function projectRootsSignature(paths: readonly string[]): string {
  return normalizeProjectRootPaths(paths).join("\0");
}

function unwrapProjectsService(projects: NativeProjectsService): NativeProjectsService {
  const unwrapped = Reflect.get(projects as object, WRAPPED_PROJECTS_SYMBOL) as
    NativeProjectsService | undefined;
  return unwrapped ?? projects;
}

async function readLocalProjectsMap(
  services: NativeWorkspaceFilesServices,
): Promise<Record<string, NativeLocalProjectEntry>> {
  try {
    const fromCatalog = await services.projectCatalog?.readLocalProjects?.();
    if (isRecord(fromCatalog)) {
      return fromCatalog as Record<string, NativeLocalProjectEntry>;
    }
  } catch {
    // Fall back to applicationState when projectCatalog is unavailable.
  }
  try {
    const fromState = await services.applicationState?.read?.("local-projects");
    if (isRecord(fromState) && isRecord(fromState.value)) {
      return fromState.value as Record<string, NativeLocalProjectEntry>;
    }
  } catch {
    // Ignore read failures.
  }
  return {};
}

export function refreshAccountScopedGlobalState(
  ownerWindow: Window,
  services?: NativeWorkspaceFilesServices | null,
  keys: readonly string[] = ACCOUNT_SCOPED_GLOBAL_STATE_KEYS,
): void {
  try {
    ownerWindow.postMessage(
      {
        type: "global-state-updated",
        keys: [...keys],
      },
      "*",
    );
    ownerWindow.postMessage(
      {
        type: "workspace-root-options-updated",
      },
      "*",
    );
  } catch {
    // Ignore postMessage errors in non-browser test stubs.
  }
  if (services?.queryCache?.invalidateQueryCache) {
    void services.queryCache
      .invalidateQueryCache({ queryKey: ["vscode", "get-global-state"] })
      .catch(() => undefined);
    void services.queryCache
      .invalidateQueryCache({ queryKey: ["workspace-root-options"] })
      .catch(() => undefined);
  }
}

export async function reconcileDuplicateLocalProjects(
  services: NativeWorkspaceFilesServices,
  ownerWindow?: Window,
): Promise<boolean> {
  if (!services.projects?.removeLocal) return false;
  const localProjects = await readLocalProjectsMap(services);
  const groups = new Map<string, NativeLocalProjectEntry[]>();
  for (const [key, entry] of Object.entries(localProjects)) {
    if (!isRecord(entry) || !Array.isArray(entry.rootPaths)) continue;
    const id = typeof entry.id === "string" && entry.id.trim().length > 0 ? entry.id : key;
    const sig = projectRootsSignature(entry.rootPaths);
    if (sig.length === 0) continue;
    const group = groups.get(sig) ?? [];
    group.push({ ...entry, id });
    groups.set(sig, group);
  }

  let modified = false;
  for (const entries of groups.values()) {
    if (entries.length <= 1) continue;
    const sorted = [...entries].sort(
      (a, b) =>
        (typeof a.createdAt === "number" ? a.createdAt : Number.MAX_SAFE_INTEGER) -
        (typeof b.createdAt === "number" ? b.createdAt : Number.MAX_SAFE_INTEGER),
    );
    const canonical = sorted[0];
    if (!canonical) continue;
    const duplicates = sorted.slice(1);
    const duplicateIds = new Set(duplicates.map((item) => item.id));

    try {
      const memberships = await services.threadProjectAssignments?.readMemberships?.();
      const assignments = memberships?.assignments ?? {};
      for (const [threadId, assignment] of Object.entries(assignments)) {
        if (
          assignment?.projectKind === "local" &&
          typeof assignment.projectId === "string" &&
          duplicateIds.has(assignment.projectId)
        ) {
          await services.threadProjectAssignments?.setAssignment?.({
            threadId,
            assignment: {
              projectKind: "local",
              projectId: canonical.id,
            },
          });
        }
      }
    } catch {
      // Continue deduplication if thread assignments cannot be read.
    }

    let nextOrder: string[] | null = null;
    try {
      const currentOrder = await services.projectPresentation?.readOrder?.();
      if (Array.isArray(currentOrder) && currentOrder.length > 0) {
        const dedupedOrder: string[] = [];
        for (const id of currentOrder) {
          if (typeof id !== "string") continue;
          const mapped = duplicateIds.has(id) ? canonical.id : id;
          if (!dedupedOrder.includes(mapped)) {
            dedupedOrder.push(mapped);
          }
        }
        nextOrder = dedupedOrder;
      }
    } catch {
      // Ignore order read errors.
    }

    try {
      const selection = await services.projectCatalog?.readSelection?.();
      if (
        selection?.type === "local" &&
        typeof selection.projectId === "string" &&
        duplicateIds.has(selection.projectId)
      ) {
        await services.applicationState?.write?.("selected-project", {
          type: "local",
          projectId: canonical.id,
        });
      }
    } catch {
      // Ignore selection update errors.
    }

    for (const duplicate of duplicates) {
      await services.projects.removeLocal(duplicate.id);
      modified = true;
    }

    if (nextOrder && services.projects.setProjectOrder) {
      await services.projects.setProjectOrder(nextOrder).catch(() => undefined);
    }
  }

  if (modified && ownerWindow) {
    refreshAccountScopedGlobalState(ownerWindow, services);
  }
  return modified;
}

export function wrapProjectsWithDeduplication(
  projects: NativeProjectsService,
  services: NativeWorkspaceFilesServices,
  ownerWindow?: Window,
): NativeProjectsService {
  const target = unwrapProjectsService(projects);

  const callTargetCreateLocal = (
    params: CreateLocalProjectRequest,
  ): NativeDisposablePromise<CreateLocalProjectResponse | null> =>
    Reflect.apply(target.createLocal, target, [
      params,
    ]) as NativeDisposablePromise<CreateLocalProjectResponse | null>;

  const createLocal = (
    params: CreateLocalProjectRequest,
  ): NativeDisposablePromise<CreateLocalProjectResponse | null> => {
    if (!isRecord(params) || !Array.isArray(params.sources) || params.sources.length === 0) {
      return callTargetCreateLocal(params);
    }

    const requestedSig = projectRootsSignature(params.sources);
    if (requestedSig.length === 0) {
      return callTargetCreateLocal(params);
    }

    let underlyingDispose: (() => void) | undefined;
    const resolvedPromise = (async (): Promise<CreateLocalProjectResponse | null> => {
      const localProjects = await readLocalProjectsMap(services);
      const matching = Object.entries(localProjects)
        .filter(
          ([, entry]) =>
            isRecord(entry) &&
            Array.isArray(entry.rootPaths) &&
            projectRootsSignature(entry.rootPaths) === requestedSig,
        )
        .map(([key, entry]) => ({
          ...entry,
          id: typeof entry.id === "string" && entry.id.trim().length > 0 ? entry.id : key,
        }))
        .sort(
          (a, b) =>
            (typeof a.createdAt === "number" ? a.createdAt : Number.MAX_SAFE_INTEGER) -
            (typeof b.createdAt === "number" ? b.createdAt : Number.MAX_SAFE_INTEGER),
        )[0];

      if (matching) {
        if (params.setActive !== false) {
          await services.applicationState
            ?.write?.("selected-project", {
              type: "local",
              projectId: matching.id,
            })
            .catch(() => undefined);
        }
        try {
          const currentOrder = await services.projectPresentation?.readOrder?.();
          if (Array.isArray(currentOrder) && services.projects?.setProjectOrder) {
            const nextOrder = [
              matching.id,
              ...currentOrder.filter((id) => typeof id === "string" && id !== matching.id),
            ];
            await services.projects.setProjectOrder(nextOrder).catch(() => undefined);
          }
        } catch {
          // Ignore project order update failures.
        }
        if (ownerWindow) {
          refreshAccountScopedGlobalState(ownerWindow, services);
        }
        return {
          projectId: matching.id,
          rootPaths: matching.rootPaths,
        };
      }

      const request = callTargetCreateLocal(params);
      const requestDispose = Reflect.get(request as object, DISPOSE_SYMBOL);
      if (typeof requestDispose === "function") {
        underlyingDispose = () => {
          try {
            Reflect.apply(requestDispose, request, []);
          } catch {
            // Ignore disposal errors.
          }
        };
      }
      try {
        const created = await request;
        await reconcileDuplicateLocalProjects(services, ownerWindow).catch(() => false);
        return created;
      } finally {
        underlyingDispose?.();
        underlyingDispose = undefined;
      }
    })();

    return attachDisposable(resolvedPromise, () => {
      underlyingDispose?.();
      underlyingDispose = undefined;
    });
  };

  return new Proxy(target, {
    get(currentTarget, prop) {
      if (prop === WRAPPED_PROJECTS_SYMBOL) return currentTarget;
      if (prop === "createLocal") return createLocal;
      return Reflect.get(currentTarget, prop, currentTarget);
    },
  });
}

function bumpMacOpenPanelResetNonce(ownerWindow: Window): void {
  const current =
    typeof ownerWindow.__codexhostMacOpenPanelResetNonceV1 === "number" &&
    Number.isFinite(ownerWindow.__codexhostMacOpenPanelResetNonceV1)
      ? ownerWindow.__codexhostMacOpenPanelResetNonceV1
      : 0;
  ownerWindow.__codexhostMacOpenPanelResetNonceV1 = current + 1;
}

function shouldRefreshAccountScopedStateOnMessage(data: unknown): boolean {
  if (!isRecord(data) || typeof data.type !== "string") return false;
  if (ACCOUNT_SCOPED_REFRESH_MESSAGE_TYPES.has(data.type)) {
    if (data.type === "codex-app-server-connection-changed" && data.state !== "connected") {
      return false;
    }
    return true;
  }
  if (
    data.type === "codex-chunked-message" &&
    data.kind === "end" &&
    typeof data.channel === "string" &&
    data.channel.includes("persisted-atom")
  ) {
    return true;
  }
  return false;
}

export function installCodexProjectDefaultDirectory(
  ownerWindow: Window = window,
  importModule?: (url: string) => Promise<Record<string, unknown>>,
): CodexProjectDefaultDirectoryHandle {
  let disposed = false;
  let installing = false;
  let reconciling = false;
  let installedServices: NativeWorkspaceFilesServices | null = null;
  let originalWorkspaceFiles: NativeWorkspaceFiles | null = null;
  let wrappedWorkspaceFiles: NativeWorkspaceFiles | null = null;
  let originalProjects: NativeProjectsService | null = null;
  let wrappedProjects: NativeProjectsService | null = null;

  bumpMacOpenPanelResetNonce(ownerWindow);

  const scheduleProjectStateSync = (): void => {
    if (disposed) return;
    refreshAccountScopedGlobalState(ownerWindow, installedServices);
    if (!installedServices || reconciling) return;
    reconciling = true;
    void reconcileDuplicateLocalProjects(installedServices, ownerWindow)
      .catch(() => false)
      .finally(() => {
        reconciling = false;
      });
  };

  const tryInstallWorkspaceFilesWrapper = (): void => {
    if (disposed || installing || installedServices !== null) return;
    installing = true;
    void (async () => {
      try {
        const services = await loadCodexNativeServices(
          ownerWindow,
          isNativeWorkspaceFilesServices,
          importModule,
        );
        if (disposed || !services || installedServices !== null) return;
        const unwrapped = unwrapWorkspaceFiles(services.workspaceFiles);
        const wrapped = wrapWorkspaceFilesWithDefaultDirectory(unwrapped);
        services.workspaceFiles = wrapped;
        installedServices = services;
        originalWorkspaceFiles = unwrapped;
        wrappedWorkspaceFiles = wrapped;
        if (
          services.projects &&
          (typeof services.projects === "object" || typeof services.projects === "function") &&
          typeof services.projects.createLocal === "function"
        ) {
          const unwrappedProj = unwrapProjectsService(services.projects);
          const wrappedProj = wrapProjectsWithDeduplication(unwrappedProj, services, ownerWindow);
          services.projects = wrappedProj;
          originalProjects = unwrappedProj;
          wrappedProjects = wrappedProj;
        }
        scheduleProjectStateSync();
      } catch {
        // Native module catalog may still be initializing; event listeners will retry.
      } finally {
        installing = false;
      }
    })();
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    const data = event.data as unknown;
    if (
      isRecord(data) &&
      typeof data.type === "string" &&
      OPEN_PANEL_RESET_MESSAGE_TYPES.has(data.type)
    ) {
      bumpMacOpenPanelResetNonce(ownerWindow);
    }
    if (shouldRefreshAccountScopedStateOnMessage(data)) {
      tryInstallWorkspaceFilesWrapper();
      scheduleProjectStateSync();
    }
  };

  const onRetrySignal = (): void => {
    tryInstallWorkspaceFilesWrapper();
  };

  ownerWindow.addEventListener("message", onMessage);
  ownerWindow.addEventListener("codexhost:draft-prewarm-policy-changed", onRetrySignal);
  ownerWindow.addEventListener("codexhost:renderer-adapter-status", onRetrySignal);

  tryInstallWorkspaceFilesWrapper();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      ownerWindow.removeEventListener("message", onMessage);
      ownerWindow.removeEventListener("codexhost:draft-prewarm-policy-changed", onRetrySignal);
      ownerWindow.removeEventListener("codexhost:renderer-adapter-status", onRetrySignal);
      if (
        installedServices &&
        originalWorkspaceFiles &&
        installedServices.workspaceFiles === wrappedWorkspaceFiles
      ) {
        installedServices.workspaceFiles = originalWorkspaceFiles;
      }
      if (installedServices && originalProjects && installedServices.projects === wrappedProjects) {
        installedServices.projects = originalProjects;
      }
      installedServices = null;
      originalWorkspaceFiles = null;
      wrappedWorkspaceFiles = null;
      originalProjects = null;
      wrappedProjects = null;
    },
  };
}
