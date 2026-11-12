import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it, onTestFinished } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "vincent-manifest-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=release");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.invalid");
  git("config", "core.autocrlf", "false");
  mkdirSync(path.join(directory, "scripts"));
  mkdirSync(path.join(directory, "vincent"));
  for (const name of ["vincent-ci.sh", "vincent-release.sh"]) {
    copyFileSync(path.join(root, "scripts", name), path.join(directory, "scripts", name));
  }
  writeFileSync(path.join(directory, "package.json"), '{"version":"0.17.4"}\n');
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  git("tag", "v0.17.4");
  git("branch", "main", "v0.17.4");
  git("switch", "--quiet", "-c", "feature");
  writeFileSync(path.join(directory, "feature.txt"), "stable\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "stable feature");
  const stable = git("rev-parse", "HEAD");
  writeFileSync(path.join(directory, "feature.txt"), "preview\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "preview feature");
  const preview = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/feature", preview);
  git("switch", "--quiet", "release");
  git("remote", "add", "origin", directory);
  git("remote", "add", "upstream", directory);
  function run(script, ...args) {
    return spawnSync("bash", [path.join(directory, "scripts", script), ...args], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        CH_REPO: directory,
        CH_WORK: path.join(directory, ".work"),
        CH_UPSTREAM_REMOTE: "upstream",
        CH_FORK_REMOTE: "origin",
      },
    });
  }
  const manifest = (value) =>
    writeFileSync(path.join(directory, "vincent", "branches.txt"), `${value}\n`);
  return { directory, git, stable, preview, run, manifest };
}

it("merges a pinned stable commit without advancing to the branch's preview head", () => {
  const f = fixture();
  f.manifest(`${f.stable} # feature`);
  const result = f.run("vincent-ci.sh", "merge", "v0.17.4");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(f.directory, "feature.txt"), "utf8"), "stable\n");
  assert.notEqual(f.git("rev-parse", "HEAD"), f.preview);
});

it("still accepts a feature branch in the release manifest", () => {
  const f = fixture();
  f.manifest("feature");
  const result = f.run("vincent-ci.sh", "merge", "v0.17.4");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(f.directory, "feature.txt"), "utf8"), "preview\n");
});

it("fails when a pinned release commit cannot be resolved", () => {
  const f = fixture();
  f.manifest("a".repeat(40));
  const result = f.run("vincent-ci.sh", "merge", "v0.17.4");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing pinned commit/);
});

it("reports pinned revisions through the local release status command", () => {
  const f = fixture();
  f.manifest(`${f.stable} # feature`);
  const result = f.run("vincent-release.sh", "status");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /MISSING/);
  assert.match(result.stdout, /1 commits to merge/);
});

it("keeps the repository manifest free of stage3 draft prefixes and ca8c7fab ancestors", () => {
  const entries = readFileSync(path.join(root, "vincent", "branches.txt"), "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
  assert.ok(entries.includes("fix/shared-host-single-lock-and-resume"));
  assert.ok(entries.includes("feat/vertical-screen-ux-overhaul"));
  for (const entry of entries) {
    assert.doesNotMatch(entry, /^stage3\//);
    assert.notEqual(entry, "07250b6fd0b2866e1154a20e81ba500a38b269a2");
    assert.notEqual(entry, "52501bacfbd009cdd291cd4e5129709f76e92ace");
  }
});
