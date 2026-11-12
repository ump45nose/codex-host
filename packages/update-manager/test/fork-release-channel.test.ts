import { describe, expect, it, vi } from "vitest";

import {
  CODEXHOST_DEFAULT_RELEASE_REPOSITORY,
  CODEXHOST_LATEST_RELEASE_URL,
  compareSemanticVersions,
  expectedNpmReleaseAssetNames,
  fetchLatestGitHubRelease,
  fetchLatestGitHubReleaseWithGitHubCli,
  hasNpmReleaseArtifacts,
  isReleaseChannelVersion,
  parseLatestGitHubRelease,
  resolveReleaseRepository,
  type GitHubCliRunner,
} from "@codexhost/update-manager";

const FORK = "https://github.com/ump45nose/codex-host";

function asset(repository: string, tag: string, name: string) {
  return {
    name,
    size: 1024,
    digest: `sha256:${"cd".repeat(32)}`,
    browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
  };
}

function forkRelease(version = "0.17.2-vincent.1", repository = "ump45nose/codex-host") {
  const tag = `v${version}`;
  return {
    tag_name: tag,
    html_url: `https://github.com/${repository}/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    body: "Vincent build",
    assets: [
      asset(repository, tag, `codexhost-cli-${version}.tgz`),
      asset(repository, tag, `codexhost-cli-${version}-macos-arm64.tgz`),
      asset(repository, tag, `codexhost-cli-${version}-macos-x64.tgz`),
      asset(repository, tag, `codexhost-cli-${version}-linux-x64.tgz`),
      asset(repository, tag, "SHA256SUMS"),
    ],
  };
}

describe("fork release channel", () => {
  it("defaults to the fork and honours CODEXHOST_UPDATE_REPOSITORY", () => {
    expect(CODEXHOST_DEFAULT_RELEASE_REPOSITORY).toBe("ump45nose/codex-host");
    expect(CODEXHOST_LATEST_RELEASE_URL).toBe(
      "https://api.github.com/repos/ump45nose/codex-host/releases/latest",
    );
    expect(resolveReleaseRepository({ environment: {} })).toBe("ump45nose/codex-host");
    expect(
      resolveReleaseRepository({
        environment: { CODEXHOST_UPDATE_REPOSITORY: " BytePioneer-AI/codex-host " },
      }),
    ).toBe("BytePioneer-AI/codex-host");
    expect(
      resolveReleaseRepository({
        repository: "someone/else",
        environment: { CODEXHOST_UPDATE_REPOSITORY: "BytePioneer-AI/codex-host" },
      }),
    ).toBe("someone/else");
    for (const invalid of ["nope", "a/b/c", "../x", "https://github.com/a/b", "a/.."]) {
      expect(() =>
        resolveReleaseRepository({ environment: { CODEXHOST_UPDATE_REPOSITORY: invalid } }),
      ).toThrow("owner/repo");
    }
  });

  it("ranks X.Y.Z-vincent.N as a post-release of upstream X.Y.Z", () => {
    expect(compareSemanticVersions("0.17.2", "0.17.2-vincent.1")).toBeLessThan(0);
    expect(compareSemanticVersions("0.17.2-vincent.1", "0.17.2")).toBeGreaterThan(0);
    expect(compareSemanticVersions("0.17.2-vincent.1", "0.17.2-vincent.2")).toBeLessThan(0);
    expect(compareSemanticVersions("0.17.2-vincent.10", "0.17.2-vincent.9")).toBeGreaterThan(0);
    expect(compareSemanticVersions("0.17.2-vincent.3", "0.17.2-vincent.3")).toBe(0);
    expect(compareSemanticVersions("0.17.2-vincent.9", "0.17.3")).toBeLessThan(0);
    expect(compareSemanticVersions("0.17.3", "0.17.2-vincent.9")).toBeGreaterThan(0);
    expect(compareSemanticVersions("0.17.2-vincent.1", "0.17.2-rc.5")).toBeGreaterThan(0);
    expect(compareSemanticVersions("0.18.0-rc.1", "0.17.2-vincent.4")).toBeGreaterThan(0);
    // Ordinary prerelease semantics are unchanged.
    expect(compareSemanticVersions("0.17.2-rc.1", "0.17.2")).toBeLessThan(0);
    expect(compareSemanticVersions("0.17.2-alpha", "0.17.2-beta")).toBeLessThan(0);
    expect(isReleaseChannelVersion("0.17.2-vincent.1")).toBe(true);
    expect(isReleaseChannelVersion("0.17.2")).toBe(false);
    expect(isReleaseChannelVersion("0.17.2-vincent")).toBe(false);
    expect(isReleaseChannelVersion("0.17.2-vincent.01")).toBe(false);
    expect(isReleaseChannelVersion("0.17.2-rc.1")).toBe(false);
  });

  it("parses fork releases and rejects other repositories", () => {
    const parsed = parseLatestGitHubRelease(forkRelease(), { environment: {} });
    expect(parsed.version).toBe("0.17.2-vincent.1");
    expect(parsed.releaseNotesUrl).toBe(`${FORK}/releases/tag/v0.17.2-vincent.1`);
    expect(() =>
      parseLatestGitHubRelease(forkRelease("0.17.2-vincent.1", "BytePioneer-AI/codex-host"), {
        environment: {},
      }),
    ).toThrow();
    expect(
      parseLatestGitHubRelease(forkRelease("0.17.2", "BytePioneer-AI/codex-host"), {
        environment: { CODEXHOST_UPDATE_REPOSITORY: "BytePioneer-AI/codex-host" },
      }).version,
    ).toBe("0.17.2");
  });

  it("requires the meta and platform npm tarballs before an npm install can update", () => {
    const parsed = parseLatestGitHubRelease(forkRelease(), { environment: {} });
    expect(expectedNpmReleaseAssetNames("0.17.2-vincent.1", "linux-x64")).toEqual([
      "codexhost-cli-0.17.2-vincent.1.tgz",
      "codexhost-cli-0.17.2-vincent.1-linux-x64.tgz",
    ]);
    expect(hasNpmReleaseArtifacts(parsed, "macos-arm64")).toBe(true);
    expect(hasNpmReleaseArtifacts(parsed, "macos-x64")).toBe(true);
    expect(hasNpmReleaseArtifacts(parsed, "linux-x64")).toBe(true);
    expect(hasNpmReleaseArtifacts(parsed, "linux-arm64")).toBe(false);
    const withoutMeta = forkRelease();
    withoutMeta.assets = withoutMeta.assets.filter(
      (entry) => entry.name !== "codexhost-cli-0.17.2-vincent.1.tgz",
    );
    expect(
      hasNpmReleaseArtifacts(
        parseLatestGitHubRelease(withoutMeta, { environment: {} }),
        "linux-x64",
      ),
    ).toBe(false);
  });

  it("picks up the fork v0.17.2-vincent.1 release over an installed upstream 0.17.2", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(forkRelease()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const latest = await fetchLatestGitHubRelease({ fetch: fetchImpl, environment: {} });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/ump45nose/codex-host/releases/latest",
      expect.anything(),
    );
    expect(compareSemanticVersions("0.17.2", latest.version)).toBeLessThan(0);
    expect(compareSemanticVersions("0.17.2-vincent.1", latest.version)).toBe(0);
  });

  it("queries the configured repository through GitHub CLI", async () => {
    const run = vi.fn<GitHubCliRunner>(async () =>
      JSON.stringify(forkRelease("0.17.2", "BytePioneer-AI/codex-host")),
    );
    const environment = { CODEXHOST_UPDATE_REPOSITORY: "BytePioneer-AI/codex-host" };
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({ environment, executableCandidates: ["gh"], run }),
    ).resolves.toMatchObject({ version: "0.17.2" });
    expect(run.mock.calls[0]?.[1].at(-1)).toBe("repos/BytePioneer-AI/codex-host/releases/latest");
  });
});
