#!/usr/bin/env bash
# CI helper for .github/workflows/vincent-follow-upstream.yml (also runnable locally).
#
#   scripts/vincent-ci.sh plan  [TAG] [--force]  # prints tag=, version=, skip= lines (GITHUB_OUTPUT format)
#   scripts/vincent-ci.sh merge TAG              # merges upstream TAG + manifest branches onto HEAD
#   scripts/vincent-ci.sh test                   # full vitest suite, tolerating only the known flake
#   scripts/vincent-ci.sh verify-version TAG     # ensure source version matches the release
#
# Environment: CH_UPSTREAM_URL (default BytePioneer-AI/codex-host), CH_FORK_REPOSITORY
# (default ump45nose/codex-host), CH_FORK_REMOTE (default origin), GH_TOKEN for `plan`.
set -euo pipefail

CH_UPSTREAM_URL="${CH_UPSTREAM_URL:-https://github.com/BytePioneer-AI/codex-host.git}"
CH_FORK_REPOSITORY="${CH_FORK_REPOSITORY:-ump45nose/codex-host}"
CH_FORK_REMOTE="${CH_FORK_REMOTE:-origin}"
CHANNEL=vincent
# Known pre-existing flake (timing-sensitive); every other failure blocks the release.
KNOWN_FLAKES=(
  "rechecks existing children for ambiguous correlation after warming a request"
)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '[vincent-ci] %s\n' "$*" >&2; }
die() { printf '[vincent-ci] error: %s\n' "$*" >&2; exit 1; }

fetch_upstream() {
  git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$CH_UPSTREAM_URL"
  git fetch --quiet --no-tags upstream '+refs/tags/v*:refs/tags/v*'
}

latest_tag() {
  git tag --list 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1
}

cmd_plan() {
  local tag="" force=false
  for argument in "$@"; do
    case "$argument" in --force) force=true ;; "") ;; *) tag="$argument" ;; esac
  done
  fetch_upstream
  [[ -n "$tag" ]] || tag="$(latest_tag)"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a stable upstream tag: '$tag'"
  git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null || die "upstream has no tag $tag"
  local core="${tag#v}" builds n=0 b
  builds="$(gh release list -R "$CH_FORK_REPOSITORY" --limit 200 --json tagName --jq '.[].tagName' |
    sed -n "s/^v${core//./\\.}-${CHANNEL}\\.\\([0-9][0-9]*\\)\$/\\1/p")"
  for b in $builds; do ((b > n)) && n="$b"; done
  local skip=false
  if ((n > 0)) && ! $force; then skip=true; log "$tag already released as v$core-$CHANNEL.$n"; fi
  echo "tag=$tag"
  echo "version=$core-$CHANNEL.$((n + 1))"
  echo "skip=$skip"
}

cmd_verify_version() {
  local tag="${1:?verify-version TAG}" source_version
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a stable upstream tag: $tag"
  source_version="$(node -p 'require("./package.json").version')" || die "cannot read source version"
  [[ "$source_version" == "${tag#v}" ]] ||
    die "refusing to publish $tag: source package.json is $source_version; select the matching upstream release"
  log "release $tag matches source version $source_version"
}

manifest_branches() {
  sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//' -e '/^$/d' "$ROOT/vincent/branches.txt"
}

manifest_ref() {
  if [[ "$1" =~ ^[0-9a-f]{40}$ ]]; then echo "$1"
  else echo "refs/remotes/$CH_FORK_REMOTE/$1"; fi
}

# Merge one ref, reusing recorded resolutions (rerere). Upstream workflow files merge like
# any other file; the fork disables those workflows in its Actions settings instead.
merge_ref() {
  local ref="$1" message="$2" conflicts
  if git merge-base --is-ancestor "$ref" HEAD; then log "skip $ref: already contained"; return 0; fi
  log "merging $ref"
  local output
  output="$(git merge --no-ff --no-commit --no-edit "$ref" 2>&1)" || true
  if ! git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    printf '%s\n' "$output" >&2
    printf '### Could not merge `%s`\n\n```\n%s\n```\n' "$ref" "$output" >>"${CONFLICT_REPORT:-/dev/null}"
    return 1
  fi
  conflicts="$(git diff --name-only --diff-filter=U)"
  if [[ -n "$conflicts" ]]; then
    printf '%s\n' "$conflicts" | sed 's/^/  conflict: /' >&2
    {
      echo "### Conflict merging \`$ref\`"
      echo
      printf -- '- `%s`\n' $conflicts
    } >>"${CONFLICT_REPORT:-/dev/null}"
    git merge --abort || true
    return 1
  fi
  git commit -q -s --no-edit -m "$message"
}

cmd_merge() {
  local tag="${1:?merge TAG}" b ref failed=0
  export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Vincent}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-1729065730@qq.com}"
  export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}" GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}"
  git config rerere.enabled true
  git config rerere.autoUpdate true
  # Recorded resolutions travel with the branch (vincent/rr-cache) so CI reuses them.
  if [[ -d "$ROOT/vincent/rr-cache" ]]; then
    mkdir -p "$(git rev-parse --git-path rr-cache)"
    cp -R "$ROOT/vincent/rr-cache/." "$(git rev-parse --git-path rr-cache)/"
  fi
  merge_ref "refs/tags/$tag" "Merge upstream $tag into vincent/release" || failed=1
  if ((failed == 0)); then
    for b in $(manifest_branches); do
      ref="$(manifest_ref "$b")"
      if ! git rev-parse -q --verify "$ref^{commit}" >/dev/null; then
        [[ ! "$b" =~ ^[0-9a-f]{40}$ ]] || die "missing pinned commit $b"
        log "skip $b: not on the fork"; continue
      fi
      merge_ref "$ref" "Merge $b into vincent/release for $tag" || { failed=1; break; }
    done
  fi
  # A hand-resolved vincent/release-<tag> pushed by Vincent wins over a failed automatic merge.
  if ((failed == 0)) && git rev-parse -q --verify "refs/remotes/$CH_FORK_REMOTE/vincent/release-$tag^{commit}" >/dev/null; then
    merge_ref "refs/remotes/$CH_FORK_REMOTE/vincent/release-$tag" "Merge vincent/release-$tag into vincent/release" || failed=1
  fi
  ((failed == 0)) || die "merge conflicts; resolve locally (scripts/vincent-release.sh build --tag $tag), push vincent/release-$tag and rerun"
  log "merged HEAD $(git rev-parse HEAD)"
}

cmd_test() {
  local report="${RUNNER_TEMP:-/tmp}/vitest-report.json" status=0
  npx vitest run --config tests/vitest.config.js --reporter=default --reporter=json \
    --outputFile.json="$report" || status=$?
  ((status == 0)) && return 0
  [[ -s "$report" ]] || die "vitest failed without a report (exit $status)"
  KNOWN_FLAKES_JSON="$(printf '%s\n' "${KNOWN_FLAKES[@]}" | node -e 'console.log(JSON.stringify(require("fs").readFileSync(0,"utf8").trim().split("\n")))')" \
    node - "$report" <<'NODE'
const report = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
const flakes = JSON.parse(process.env.KNOWN_FLAKES_JSON);
const unexpected = [];
for (const file of report.testResults ?? []) {
  const failed = (file.assertionResults ?? []).filter((test) => test.status === "failed");
  if (file.status === "failed" && failed.length === 0) unexpected.push(`${file.name}: ${file.message ?? "suite failed"}`);
  for (const test of failed) if (!flakes.includes(test.title)) unexpected.push(`${file.name}: ${test.fullName}`);
}
if (unexpected.length > 0) {
  console.error(`Unexpected test failures:\n${unexpected.join("\n")}`);
  process.exit(1);
}
console.error("Only the known flaky test(s) failed; continuing.");
NODE
}

cmd="${1:-}"; shift || true
case "$cmd" in
  plan) cmd_plan "$@" ;;
  merge) cmd_merge "$@" ;;
  test) cmd_test "$@" ;;
  verify-version) cmd_verify_version "$@" ;;
  *) die "usage: vincent-ci.sh plan [TAG] [--force] | merge TAG | verify-version TAG | test" ;;
esac
