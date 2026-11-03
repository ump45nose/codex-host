import { DelegationControlError } from "./delegation-types.js";
import {
  ExternalClientRegistry,
  defaultExternalClientsPath,
  type ClientAccess,
  type ClientNetwork,
  type ClientScope,
} from "./external-clients.js";

/** `--scope` and `--network` as given; the registry validates the values. */
function accessOptions(options: {
  scope?: string | undefined;
  network?: string | undefined;
}): Partial<ClientAccess> {
  return {
    ...(options.scope ? { scope: options.scope as ClientScope } : {}),
    ...(options.network
      ? {
          networks: options.network
            .split(",")
            .map((network) => network.trim())
            .filter(Boolean) as ClientNetwork[],
        }
      : {}),
  };
}

/** `codexhost client add|list|set|remove`: edits the local registry; no Runtime is needed. */
export async function runClientCommand(
  command: string | undefined,
  positionals: readonly string[],
  environment: NodeJS.ProcessEnv,
  options: { scope?: string | undefined; network?: string | undefined } = {},
): Promise<unknown> {
  const clients = new ExternalClientRegistry(defaultExternalClientsPath(environment));
  const access = accessOptions(options);
  if (command === "list") {
    if (positionals.length > 0)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "client list accepts no positional arguments",
      );
    return { clients: await clients.list() };
  }
  if (command === "add" || command === "remove" || command === "set") {
    const name = positionals.length === 1 ? positionals[0] : undefined;
    if (!name)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `client ${command} requires one client name`,
      );
    if (command === "remove") {
      await clients.remove(name);
      return { name, removed: true };
    }
    if (command === "set") {
      if (Object.keys(access).length === 0)
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          "client set requires --scope or --network",
        );
      return clients.setAccess(name, access);
    }
    const { client, token } = await clients.add(name, access);
    return {
      ...client,
      token,
      note: "Store this token now; it is not shown again. Set CODEXHOST_CLIENT_TOKEN to it in the client.",
    };
  }
  throw new DelegationControlError(
    "INVALID_ARGUMENT",
    "Unknown client command. Run 'codexhost client --help'.",
  );
}
