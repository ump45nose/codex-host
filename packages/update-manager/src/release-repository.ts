/**
 * Release source used by the in-app update check.
 *
 * The Vincent fork publishes its own builds as GitHub Releases on
 * `ump45nose/codex-host`, versioned `X.Y.Z-vincent.N` on top of upstream `vX.Y.Z`.
 * `CODEXHOST_UPDATE_REPOSITORY=owner/repo` overrides the source at runtime (the
 * Rust updater helper reads the same variable), e.g. `BytePioneer-AI/codex-host`
 * to go back to upstream releases.
 */
export const CODEXHOST_DEFAULT_RELEASE_REPOSITORY = "ump45nose/codex-host";
export const CODEXHOST_UPSTREAM_RELEASE_REPOSITORY = "BytePioneer-AI/codex-host";
export const CODEXHOST_UPDATE_REPOSITORY_ENV = "CODEXHOST_UPDATE_REPOSITORY";
/** Prerelease identifier the fork uses for its post-release channel builds. */
export const CODEXHOST_RELEASE_CHANNEL = "vincent";

const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;

export interface ReleaseRepositoryOptions {
  /** Explicit `owner/repo`; wins over the environment. */
  repository?: string;
  environment?: NodeJS.ProcessEnv;
}

export function requireReleaseRepository(value: string): string {
  const repository = value.trim();
  if (!REPOSITORY_PATTERN.test(repository) || repository.includes("..")) {
    throw new Error(`Release repository must be owner/repo, got ${JSON.stringify(value)}`);
  }
  return repository;
}

export function resolveReleaseRepository(options: ReleaseRepositoryOptions = {}): string {
  if (options.repository !== undefined) return requireReleaseRepository(options.repository);
  const configured = (options.environment ?? process.env)[CODEXHOST_UPDATE_REPOSITORY_ENV];
  if (configured !== undefined && configured.trim().length > 0) {
    return requireReleaseRepository(configured);
  }
  return CODEXHOST_DEFAULT_RELEASE_REPOSITORY;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

export interface ReleaseRepositoryUrls {
  repository: string;
  latestReleaseApiUrl: string;
  latestReleaseGitHubCliEndpoint: string;
  releaseNotesUrlPattern: RegExp;
  downloadUrlPrefix: string;
}

export function releaseRepositoryUrls(repository: string): ReleaseRepositoryUrls {
  const checked = requireReleaseRepository(repository);
  return Object.freeze({
    repository: checked,
    latestReleaseApiUrl: `https://api.github.com/repos/${checked}/releases/latest`,
    latestReleaseGitHubCliEndpoint: `repos/${checked}/releases/latest`,
    releaseNotesUrlPattern: new RegExp(
      `^https:\\/\\/github\\.com\\/${escapeRegExp(checked)}\\/releases\\/tag\\/(v[0-9A-Za-z.+-]+)$`,
      "u",
    ),
    downloadUrlPrefix: `https://github.com/${checked}/releases/download/`,
  });
}

/** `vincent.N` → N, otherwise null. */
export function releaseChannelBuild(prerelease: string | undefined): number | null {
  if (prerelease === undefined) return null;
  const match = new RegExp(`^${CODEXHOST_RELEASE_CHANNEL}\\.(0|[1-9]\\d*)$`, "u").exec(prerelease);
  return match ? Number(match[1]) : null;
}

export function isReleaseChannelVersion(version: string): boolean {
  return releaseChannelBuild(version.split("+", 1)[0]?.split("-").slice(1).join("-")) !== null;
}
