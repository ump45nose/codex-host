import { packageMetadata as harnessAdapter } from "@codexhost/harness-adapter";
import { WORKSPACE_CONTRACT_VERSION } from "@codexhost/shared-contracts";

export { ZCodeAppServer, ZCodeAppServerError } from "./app-server.js";
export {
  decodeZCodeModelRef,
  decodeZCodeThinkingOption,
  encodeZCodeModelRef,
  encodeZCodeThinkingOption,
  zcodeModelCatalog,
} from "./model-catalog.js";
export { ZCodeAdapter } from "./zcode-adapter.js";

export const packageMetadata = {
  name: "@codexhost/adapter-zcode",
  contractVersion: WORKSPACE_CONTRACT_VERSION,
  adapterContract: harnessAdapter.name,
} as const;
