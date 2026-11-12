import { loadCodexNativeServices } from "./codex-native-services.js";

export const DEFAULT_PROJECT_PERSONAL_REPOS_SUBPATH = "Developer/Repos/Personal";

const WRAPPED_WORKSPACE_FILES_SYMBOL = Symbol.for(
  "codexhost.workspaceFilesDefaultDirectoryWrappedV1",
);
const DISPOSE_SYMBOL: symbol =
  (Symbol as { readonly dispose?: symbol }).dispose ?? Symbol.for("Symbol.dispose");

const OPEN_PANEL_RESET_MESSAGE_TYPES = new Set([
  "workspace-root-option-picked",
  "workspace-root-option-added",
  "workspace-root-option-add-canceled",
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

export interface NativeWorkspaceFilesServices {
  workspaceFiles: NativeWorkspaceFiles;
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

function bumpMacOpenPanelResetNonce(ownerWindow: Window): void {
  const current =
    typeof ownerWindow.__codexhostMacOpenPanelResetNonceV1 === "number" &&
    Number.isFinite(ownerWindow.__codexhostMacOpenPanelResetNonceV1)
      ? ownerWindow.__codexhostMacOpenPanelResetNonceV1
      : 0;
  ownerWindow.__codexhostMacOpenPanelResetNonceV1 = current + 1;
}

export function installCodexProjectDefaultDirectory(
  ownerWindow: Window = window,
  importModule?: (url: string) => Promise<Record<string, unknown>>,
): CodexProjectDefaultDirectoryHandle {
  let disposed = false;
  let installing = false;
  let installedServices: NativeWorkspaceFilesServices | null = null;
  let originalWorkspaceFiles: NativeWorkspaceFiles | null = null;
  let wrappedWorkspaceFiles: NativeWorkspaceFiles | null = null;

  bumpMacOpenPanelResetNonce(ownerWindow);

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
      installedServices = null;
      originalWorkspaceFiles = null;
      wrappedWorkspaceFiles = null;
    },
  };
}
