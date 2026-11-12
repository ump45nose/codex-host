import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import { MappingStore } from "@codexhost/mapping-store";

import type { AppServerHost } from "./app-server-host.js";
import type { DelegationControlRegistration } from "./delegation-types.js";
import type { ExternalThreadStore, MappingStoreOwnerRole } from "./external-thread-repository.js";
import { codexhostDataDirectory } from "./external-clients.js";
import { sharedHostDataDirectory } from "./local-shared-host.js";
import type { SharedThreadBridge } from "./shared-thread-bridge.js";

export interface SharedExternalThreadRuntimeOptions {
  environment: NodeJS.ProcessEnv;
  ownerRole: MappingStoreOwnerRole;
  onFatalError?: () => void;
  createBridge(): SharedThreadBridge;
  createExternalHost(options: {
    mappingStore: ExternalThreadStore;
    desktopInput: PassThrough;
    desktopOutput: PassThrough;
    sharedThreads: SharedThreadBridge;
    onDelegationApi: (api: DelegationControlRegistration) => (() => void) | undefined;
  }): AppServerHost;
  registerCatalogDelegation(api: DelegationControlRegistration): (() => void) | undefined;
}

export interface SharedExternalThreadRuntime {
  readonly mappingStore: ExternalThreadStore;
  readonly sharedDelegation: DelegationControlRegistration | undefined;
  createBridge(): SharedThreadBridge;
  close(): Promise<void>;
}

/** Viewers retain private legacy records, but never compete with the service's store. */
export async function createSharedExternalThreadRuntime(
  options: SharedExternalThreadRuntimeOptions,
): Promise<SharedExternalThreadRuntime> {
  const dataDirectory = codexhostDataDirectory(options.environment);
  const sharedDirectory = sharedHostDataDirectory(options.environment);
  let temporaryDirectory: string | undefined;
  if (dataDirectory === sharedDirectory) {
    await mkdir(dataDirectory, { recursive: true });
    temporaryDirectory = await mkdtemp(path.join(dataDirectory, ".viewer-mapping-store-"));
  }
  const mappingStore = new MappingStore({
    directory: temporaryDirectory ?? path.join(dataDirectory, "mapping-store"),
    ownerRole: options.ownerRole,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  // This catalog serves delegation RPCs; client notifications use their own bridges.
  output.resume();
  let delegation: DelegationControlRegistration | undefined;
  let host: AppServerHost | undefined;
  let running: Promise<number> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      host?.close();
      await running?.catch(() => undefined);
    } finally {
      input.destroy();
      output.destroy();
      try {
        await mappingStore.close();
      } finally {
        if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  };
  try {
    await mappingStore.initialize();
    host = options.createExternalHost({
      mappingStore,
      desktopInput: input,
      desktopOutput: output,
      sharedThreads: options.createBridge(),
      onDelegationApi: (api) => {
        delegation = api;
        return options.registerCatalogDelegation(api);
      },
    });
    running = host.run();
    const onStopped = () => {
      if (!closed) options.onFatalError?.();
    };
    void running.then(onStopped, onStopped);
    return {
      mappingStore,
      get sharedDelegation() {
        return delegation;
      },
      createBridge: options.createBridge,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
