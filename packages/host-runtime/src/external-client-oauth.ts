import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { writeJson } from "./delegation-control-server.js";
import { DelegationControlError } from "./delegation-types.js";
import {
  codexhostDataDirectory,
  type AuthenticatedClient,
  type ExternalClientRegistry,
} from "./external-clients.js";

const PAIRING_PREFIX = "chp_";
const ACCESS_TOKEN_PREFIX = "choa_";
const REFRESH_TOKEN_PREFIX = "chor_";
const AUTH_CODE_PREFIX = "choc_";

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_PAIRING_FAILURES = 5;
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const ACCESS_TOKEN_TTL_MS = ACCESS_TOKEN_TTL_SECONDS * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredPairingCode {
  client: string;
  salt: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  failures: number;
}

interface StoredOAuthToken {
  client: string;
  oauthClientId?: string;
  salt: string;
  accessTokenHash: string;
  accessExpiresAt: string;
  refreshTokenHash: string;
  refreshExpiresAt: string;
  createdAt: string;
}

interface StoredDynamicClient {
  clientId: string;
  redirectUris: string[];
  createdAt: string;
}

interface StoredAuthorizationCode {
  client: string;
  oauthClientId: string;
  redirectUri: string;
  codeChallenge: string;
  salt: string;
  codeHash: string;
  expiresAt: string;
}

interface OAuthFile {
  formatVersion: 1;
  pairings: StoredPairingCode[];
  tokens: StoredOAuthToken[];
  dynamicClients?: StoredDynamicClient[];
  authorizationCodes?: StoredAuthorizationCode[];
}

export function defaultExternalClientOAuthPath(environment: NodeJS.ProcessEnv): string {
  return path.join(codexhostDataDirectory(environment), "external-client-oauth.json");
}

function hashSecret(salt: string, secret: string): string {
  return createHash("sha256").update(salt).update(secret).digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function pkceChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isValidRedirectUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Persistent store for one-time pairing codes, authorization codes, dynamic
 * OAuth client registrations, and hashed access/refresh tokens.
 */
export class ExternalClientOAuthStore {
  readonly #filePath: string;
  readonly #now: () => Date;

  constructor(filePath: string, now: () => Date = () => new Date()) {
    this.#filePath = filePath;
    this.#now = now;
  }

  /** Creates a 10-minute single-use pairing code for a registered external client. */
  async createPairingCode(
    client: string,
    now: Date = this.#now(),
  ): Promise<{ client: string; code: string; expiresAt: string }> {
    const data = await this.#read(now);
    const code = `${PAIRING_PREFIX}${randomBytes(12).toString("base64url")}`;
    const salt = randomBytes(16).toString("hex");
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
    const entry: StoredPairingCode = {
      client,
      salt,
      codeHash: hashSecret(salt, code),
      createdAt: now.toISOString(),
      expiresAt,
      failures: 0,
    };
    data.pairings = [...data.pairings.filter((item) => item.client !== client), entry];
    await this.#write(data);
    return { client, code, expiresAt };
  }

  /** Removes all pairing codes and OAuth tokens for a revoked client. */
  async revokeClient(client: string): Promise<void> {
    const data = await this.#read(this.#now());
    const pairings = data.pairings.filter((item) => item.client !== client);
    const tokens = data.tokens.filter((item) => item.client !== client);
    const authorizationCodes = (data.authorizationCodes ?? []).filter(
      (item) => item.client !== client,
    );
    if (
      pairings.length !== data.pairings.length ||
      tokens.length !== data.tokens.length ||
      authorizationCodes.length !== (data.authorizationCodes ?? []).length
    ) {
      await this.#write({ ...data, pairings, tokens, authorizationCodes });
    }
  }

  /** Registers a dynamic OAuth client (RFC 7591). */
  async registerDynamicClient(
    redirectUris: string[],
    now: Date = this.#now(),
  ): Promise<{ clientId: string; issuedAt: number; redirectUris: string[] }> {
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.some((uri) => typeof uri !== "string" || !isValidRedirectUri(uri))
    ) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "redirect_uris must be a non-empty array of valid URLs",
      );
    }
    const data = await this.#read(now);
    const clientId = `dyn_${randomBytes(16).toString("base64url")}`;
    const dynamicClients = [
      ...(data.dynamicClients ?? []),
      { clientId, redirectUris, createdAt: now.toISOString() },
    ];
    await this.#write({ ...data, dynamicClients });
    return {
      clientId,
      issuedAt: Math.floor(now.getTime() / 1000),
      redirectUris,
    };
  }

  /** Validates whether a client_id + redirect_uri pair is permitted. */
  async validateRedirectUri(oauthClientId: string, redirectUri: string): Promise<boolean> {
    if (!oauthClientId || !isValidRedirectUri(redirectUri)) return false;
    const data = await this.#read(this.#now());
    const registered = (data.dynamicClients ?? []).find((item) => item.clientId === oauthClientId);
    return registered ? registered.redirectUris.includes(redirectUri) : true;
  }

  /**
   * Verifies and consumes a one-time pairing code, or records a failed attempt.
   * After 5 consecutive failures for a client's active pairing code, that code
   * is invalidated and must be regenerated.
   */
  async redeemPairingCode(input: {
    pairingCode: string;
    oauthClientId: string;
    redirectUri: string;
    codeChallenge: string;
    now?: Date;
  }): Promise<string | undefined> {
    const now = input.now ?? this.#now();
    const data = await this.#read(now);
    const trimmed = input.pairingCode.trim();
    let matched: StoredPairingCode | undefined;
    if (trimmed.startsWith(PAIRING_PREFIX)) {
      for (const entry of data.pairings) {
        if (sameHash(hashSecret(entry.salt, trimmed), entry.codeHash)) {
          matched = entry;
        }
      }
    }
    if (!matched) {
      // Increment failure count on active pairing codes; drop any that hit MAX_PAIRING_FAILURES.
      data.pairings = data.pairings
        .map((entry) => ({ ...entry, failures: entry.failures + 1 }))
        .filter((entry) => entry.failures < MAX_PAIRING_FAILURES);
      await this.#write(data);
      return undefined;
    }
    // Consume the pairing code so it can never be reused.
    data.pairings = data.pairings.filter((entry) => entry !== matched);
    const authCode = `${AUTH_CODE_PREFIX}${randomBytes(24).toString("base64url")}`;
    const salt = randomBytes(16).toString("hex");
    const authorizationCodes: StoredAuthorizationCode[] = [
      ...(data.authorizationCodes ?? []),
      {
        client: matched.client,
        oauthClientId: input.oauthClientId,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        salt,
        codeHash: hashSecret(salt, authCode),
        expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_MS).toISOString(),
      },
    ];
    await this.#write({ ...data, authorizationCodes });
    return authCode;
  }

  /** Exchanges a single-use authorization code + PKCE verifier for access and refresh tokens. */
  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    oauthClientId?: string;
    redirectUri?: string;
    clients: ExternalClientRegistry;
    now?: Date;
  }): Promise<
    | {
        client: string;
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        scope: string;
      }
    | undefined
  > {
    const now = input.now ?? this.#now();
    const data = await this.#read(now);
    if (!input.code.startsWith(AUTH_CODE_PREFIX) || !input.codeVerifier) return undefined;
    let matched: StoredAuthorizationCode | undefined;
    for (const entry of data.authorizationCodes ?? []) {
      if (sameHash(hashSecret(entry.salt, input.code), entry.codeHash)) {
        matched = entry;
      }
    }
    if (!matched) return undefined;
    // Always consume the authorization code on first use attempt.
    data.authorizationCodes = (data.authorizationCodes ?? []).filter((entry) => entry !== matched);
    await this.#write(data);

    if (input.oauthClientId && input.oauthClientId !== matched.oauthClientId) return undefined;
    if (input.redirectUri && input.redirectUri !== matched.redirectUri) return undefined;
    if (pkceChallengeS256(input.codeVerifier) !== matched.codeChallenge) return undefined;

    const registered = (await input.clients.list()).find((item) => item.name === matched.client);
    if (!registered || !registered.networks.includes("public")) return undefined;

    return this.#issueTokens(data, matched.client, registered.scope, matched.oauthClientId, now);
  }

  /** Exchanges a valid refresh token for a new access and refresh token pair. */
  async exchangeRefreshToken(input: {
    refreshToken: string;
    oauthClientId?: string;
    clients: ExternalClientRegistry;
    now?: Date;
  }): Promise<
    | {
        client: string;
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        scope: string;
      }
    | undefined
  > {
    const now = input.now ?? this.#now();
    const data = await this.#read(now);
    if (!input.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return undefined;
    let matched: StoredOAuthToken | undefined;
    for (const entry of data.tokens) {
      if (sameHash(hashSecret(entry.salt, input.refreshToken), entry.refreshTokenHash)) {
        matched = entry;
      }
    }
    if (!matched) return undefined;
    data.tokens = data.tokens.filter((entry) => entry !== matched);
    await this.#write(data);

    if (
      input.oauthClientId &&
      matched.oauthClientId &&
      input.oauthClientId !== matched.oauthClientId
    ) {
      return undefined;
    }
    const registered = (await input.clients.list()).find((item) => item.name === matched.client);
    if (!registered || !registered.networks.includes("public")) return undefined;

    return this.#issueTokens(data, matched.client, registered.scope, matched.oauthClientId, now);
  }

  /** Authenticates an OAuth access token against the current client registry. */
  async authenticateAccessToken(
    token: string | undefined,
    clients: ExternalClientRegistry,
    now: Date = this.#now(),
  ): Promise<AuthenticatedClient | undefined> {
    if (!token?.startsWith(ACCESS_TOKEN_PREFIX)) return undefined;
    const data = await this.#read(now);
    let matched: StoredOAuthToken | undefined;
    for (const entry of data.tokens) {
      if (
        Date.parse(entry.accessExpiresAt) > now.getTime() &&
        sameHash(hashSecret(entry.salt, token), entry.accessTokenHash)
      ) {
        matched = entry;
      }
    }
    if (!matched) return undefined;
    const registered = (await clients.list()).find((item) => item.name === matched.client);
    if (!registered) return undefined;
    return {
      name: registered.name,
      scope: registered.scope,
      networks: registered.networks,
    };
  }

  async #issueTokens(
    data: OAuthFile,
    client: string,
    scope: string,
    oauthClientId: string | undefined,
    now: Date,
  ): Promise<{
    client: string;
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    scope: string;
  }> {
    const accessToken = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const salt = randomBytes(16).toString("hex");
    const record: StoredOAuthToken = {
      client,
      ...(oauthClientId ? { oauthClientId } : {}),
      salt,
      accessTokenHash: hashSecret(salt, accessToken),
      accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString(),
      refreshTokenHash: hashSecret(salt, refreshToken),
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
      createdAt: now.toISOString(),
    };
    data.tokens = [...data.tokens, record];
    await this.#write(data);
    return {
      client,
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      scope,
    };
  }

  async #read(now: Date): Promise<OAuthFile> {
    const nowMs = now.getTime();
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as Partial<OAuthFile>;
      if (parsed?.formatVersion !== 1) {
        return { formatVersion: 1, pairings: [], tokens: [] };
      }
      const pairings = Array.isArray(parsed.pairings)
        ? parsed.pairings.filter(
            (entry) =>
              typeof entry?.client === "string" &&
              typeof entry.salt === "string" &&
              typeof entry.codeHash === "string" &&
              typeof entry.expiresAt === "string" &&
              Date.parse(entry.expiresAt) > nowMs &&
              typeof entry.failures === "number" &&
              entry.failures < MAX_PAIRING_FAILURES,
          )
        : [];
      const tokens = Array.isArray(parsed.tokens)
        ? parsed.tokens.filter(
            (entry) =>
              typeof entry?.client === "string" &&
              typeof entry.salt === "string" &&
              typeof entry.accessTokenHash === "string" &&
              typeof entry.accessExpiresAt === "string" &&
              typeof entry.refreshTokenHash === "string" &&
              typeof entry.refreshExpiresAt === "string" &&
              Date.parse(entry.refreshExpiresAt) > nowMs,
          )
        : [];
      const dynamicClients = Array.isArray(parsed.dynamicClients) ? parsed.dynamicClients : [];
      const authorizationCodes = Array.isArray(parsed.authorizationCodes)
        ? parsed.authorizationCodes.filter(
            (entry) =>
              typeof entry?.client === "string" &&
              typeof entry.expiresAt === "string" &&
              Date.parse(entry.expiresAt) > nowMs,
          )
        : [];
      return { formatVersion: 1, pairings, tokens, dynamicClients, authorizationCodes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { formatVersion: 1, pairings: [], tokens: [] };
      }
      throw error;
    }
  }

  async #write(data: OAuthFile): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.#filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

const AUTHORIZE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function renderAuthorizePage(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  error?: string;
}): string {
  const errorBlock = input.error
    ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize External Client · codexhost</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #faf9f5; color: #141413; margin: 0; padding: 48px 16px; }
    main { max-width: 420px; margin: 0 auto; background: #ffffff; border: 1px solid #e6e4dd; border-radius: 12px; padding: 24px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { font-size: 14px; color: #5e5d59; line-height: 1.5; margin: 0 0 16px; }
    p.error { color: #b42318; background: #fef3f2; border: 1px solid #fecdca; border-radius: 8px; padding: 10px 12px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #d5d3cb; border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; margin-bottom: 16px; }
    button { width: 100%; padding: 10px 14px; border: 0; border-radius: 8px; background: #c96442; color: #ffffff; font-size: 14px; font-weight: 600; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Pair External Client</h1>
    <p>Enter the one-time pairing code generated on your machine with <code>codexhost client pair &lt;name&gt;</code>.</p>
    ${errorBlock}
    <form method="post" action="authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(input.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(input.redirectUri)}">
      <input type="hidden" name="response_type" value="code">
      <input type="hidden" name="state" value="${escapeHtml(input.state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(input.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(input.codeChallengeMethod)}">
      <label for="pairing_code">Pairing Code</label>
      <input id="pairing_code" name="pairing_code" type="password" autocomplete="one-time-code" required autofocus>
      <button type="submit">Authorize</button>
    </form>
  </main>
</body>
</html>
`;
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "content-security-policy": AUTHORIZE_CSP,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(html);
}

async function readBodyText(request: IncomingMessage, maxBytes = 16 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readFormOrJson(request: IncomingMessage): Promise<Record<string, string>> {
  const raw = (await readBodyText(request)).trim();
  if (!raw) return {};
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    out[key] = value;
  }
  return out;
}

export function resolvePublicBaseUrl(
  request: IncomingMessage,
  configuredPublicUrl?: () => string | undefined,
): string {
  const configured = configuredPublicUrl?.();
  if (configured) return configured.replace(/\/+$/u, "");
  const protoHeader = request.headers["x-forwarded-proto"];
  const firstProto = typeof protoHeader === "string" ? protoHeader.split(",")[0]?.trim() : "";
  const proto = firstProto || "http";
  const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "127.0.0.1";
  const hostValue = Array.isArray(host) ? host[0] : host;
  return `${proto}://${hostValue}`;
}

export function stripPublicPrefix(pathname: string): string {
  if (pathname === "/codexhost") return "/";
  if (pathname.startsWith("/codexhost/")) return pathname.slice("/codexhost".length);
  return pathname;
}

/**
 * Handles unauthenticated OAuth discovery, registration, authorization page,
 * and token exchange routes on the `public` listener. Returns `true` when the
 * request matched an OAuth route and was answered.
 */
export async function handlePublicOAuthRoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  oauth: ExternalClientOAuthStore;
  clients: ExternalClientRegistry;
  publicBaseUrl?: () => string | undefined;
}): Promise<boolean> {
  const { request, response, oauth, clients } = input;
  const pathname = stripPublicPrefix(input.url.pathname);
  const base = resolvePublicBaseUrl(request, input.publicBaseUrl);

  if (
    request.method === "GET" &&
    (pathname === "/.well-known/oauth-protected-resource" ||
      pathname === "/.well-known/oauth-protected-resource/mcp" ||
      pathname === "/.well-known/oauth-protected-resource/codexhost" ||
      pathname === "/.well-known/oauth-protected-resource/codexhost/mcp")
  ) {
    writeJson(response, 200, {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
    });
    return true;
  }

  if (
    request.method === "GET" &&
    (pathname === "/.well-known/oauth-authorization-server" ||
      pathname === "/.well-known/oauth-authorization-server/codexhost" ||
      pathname === "/.well-known/openid-configuration" ||
      pathname === "/.well-known/openid-configuration/codexhost")
  ) {
    writeJson(response, 200, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });
    return true;
  }

  if (pathname === "/oauth/register") {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "invalid_request", error_description: "POST is required" });
      return true;
    }
    try {
      const body = JSON.parse((await readBodyText(request)) || "{}") as {
        redirect_uris?: unknown;
        client_name?: unknown;
      };
      const redirectUris = Array.isArray(body.redirect_uris)
        ? (body.redirect_uris as string[])
        : [];
      const registered = await oauth.registerDynamicClient(redirectUris);
      writeJson(response, 201, {
        client_id: registered.clientId,
        client_id_issued_at: registered.issuedAt,
        redirect_uris: registered.redirectUris,
        ...(typeof body.client_name === "string" ? { client_name: body.client_name } : {}),
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    } catch (error) {
      writeJson(response, 400, {
        error: "invalid_client_metadata",
        error_description: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (pathname === "/oauth/authorize") {
    if (request.method === "GET") {
      const clientId = input.url.searchParams.get("client_id") ?? "";
      const redirectUri = input.url.searchParams.get("redirect_uri") ?? "";
      const responseType = input.url.searchParams.get("response_type") ?? "code";
      const state = input.url.searchParams.get("state") ?? "";
      const codeChallenge = input.url.searchParams.get("code_challenge") ?? "";
      const codeChallengeMethod = input.url.searchParams.get("code_challenge_method") ?? "S256";
      if (
        responseType !== "code" ||
        codeChallengeMethod !== "S256" ||
        !codeChallenge ||
        !(await oauth.validateRedirectUri(clientId, redirectUri))
      ) {
        sendHtml(
          response,
          400,
          renderAuthorizePage({
            clientId,
            redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod,
            error:
              "Invalid OAuth authorization parameters (PKCE S256 and valid redirect_uri are required).",
          }),
        );
        return true;
      }
      sendHtml(
        response,
        200,
        renderAuthorizePage({
          clientId,
          redirectUri,
          state,
          codeChallenge,
          codeChallengeMethod,
        }),
      );
      return true;
    }

    if (request.method === "POST") {
      const form = await readFormOrJson(request);
      const clientId = form.client_id ?? "";
      const redirectUri = form.redirect_uri ?? "";
      const responseType = form.response_type ?? "code";
      const state = form.state ?? "";
      const codeChallenge = form.code_challenge ?? "";
      const codeChallengeMethod = form.code_challenge_method ?? "S256";
      const pairingCode = form.pairing_code ?? "";
      if (
        responseType !== "code" ||
        codeChallengeMethod !== "S256" ||
        !codeChallenge ||
        !(await oauth.validateRedirectUri(clientId, redirectUri))
      ) {
        sendHtml(
          response,
          400,
          renderAuthorizePage({
            clientId,
            redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod,
            error: "Invalid OAuth authorization parameters.",
          }),
        );
        return true;
      }
      const authCode = await oauth.redeemPairingCode({
        pairingCode,
        oauthClientId: clientId,
        redirectUri,
        codeChallenge,
      });
      if (!authCode) {
        sendHtml(
          response,
          400,
          renderAuthorizePage({
            clientId,
            redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod,
            error: "Invalid or expired pairing code.",
          }),
        );
        return true;
      }
      const target = new URL(redirectUri);
      target.searchParams.set("code", authCode);
      if (state) target.searchParams.set("state", state);
      response.writeHead(303, {
        location: target.toString(),
        "cache-control": "no-store",
      });
      response.end();
      return true;
    }

    writeJson(response, 405, {
      error: "invalid_request",
      error_description: "GET or POST required",
    });
    return true;
  }

  if (pathname === "/oauth/token") {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "invalid_request", error_description: "POST is required" });
      return true;
    }
    const params = await readFormOrJson(request);
    const grantType = params.grant_type;
    if (grantType === "authorization_code") {
      const exchanged = await oauth.exchangeAuthorizationCode({
        code: params.code ?? "",
        codeVerifier: params.code_verifier ?? "",
        ...(params.client_id ? { oauthClientId: params.client_id } : {}),
        ...(params.redirect_uri ? { redirectUri: params.redirect_uri } : {}),
        clients,
      });
      if (!exchanged) {
        writeJson(response, 400, {
          error: "invalid_grant",
          error_description: "Authorization code or PKCE verifier is invalid or expired",
        });
        return true;
      }
      writeJson(response, 200, {
        access_token: exchanged.accessToken,
        token_type: "Bearer",
        expires_in: exchanged.expiresIn,
        refresh_token: exchanged.refreshToken,
        scope: exchanged.scope,
      });
      return true;
    }
    if (grantType === "refresh_token") {
      const refreshed = await oauth.exchangeRefreshToken({
        refreshToken: params.refresh_token ?? "",
        ...(params.client_id ? { oauthClientId: params.client_id } : {}),
        clients,
      });
      if (!refreshed) {
        writeJson(response, 400, {
          error: "invalid_grant",
          error_description: "Refresh token is invalid, expired, or revoked",
        });
        return true;
      }
      writeJson(response, 200, {
        access_token: refreshed.accessToken,
        token_type: "Bearer",
        expires_in: refreshed.expiresIn,
        refresh_token: refreshed.refreshToken,
        scope: refreshed.scope,
      });
      return true;
    }
    writeJson(response, 400, {
      error: "unsupported_grant_type",
      error_description: "Supported grant_types are authorization_code and refresh_token",
    });
    return true;
  }

  return false;
}
