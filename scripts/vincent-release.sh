#!/usr/bin/env bash
# Build Vincent's CodexHost fork on top of each upstream release and deploy it
# over an existing npm install without restarting anything.
#
#   scripts/vincent-release.sh status
#   scripts/vincent-release.sh build  [--tag vX.Y.Z] [--fresh] [--skip-conflicts] [--no-test] [--rust]
#        (starts from the previous vincent/release-vX.Y.Z so past conflict fixes carry over; --fresh starts from the tag)
#   scripts/vincent-release.sh push   [--tag vX.Y.Z]
#   scripts/vincent-release.sh auto   [--skip-conflicts]      # build+push only when a new upstream tag exists
#   scripts/vincent-release.sh deploy local [--tag vX.Y.Z] [--artifacts DIR] [--dry-run] [--allow-version-mismatch]
#   scripts/vincent-release.sh deploy ssh USER@HOST [same options]   # copies artifacts + this script, runs "deploy local" there
#   scripts/vincent-release.sh rollback [BACKUP_DIR]           # restore the newest (or given) backup on this machine
#   scripts/vincent-release.sh stale [--ssh USER@HOST]         # list running CodexHost processes older than the install
#   scripts/vincent-release.sh patch [--targets local|SSH_HOST ...] [--dry-run] [--undo]
#   scripts/vincent-release.sh audit                         # read-only: upstream ancestry, equivalent commits, PR state
#
# Environment:
#   CH_REPO            git clone used for building (default: the clone containing this script)
#   CH_UPSTREAM_REMOTE remote of BytePioneer-AI/codex-host (default: auto-detect by URL)
#   CH_FORK_REMOTE     remote of ump45nose/codex-host       (default: auto-detect by URL)
#   CH_WORK            where per-tag worktrees and artifacts live (default: ~/.codexhost-vincent)
#   CH_APP_DIR         installed app/ directory to deploy into (default: auto-detect from `npm root -g`)
#   CH_SUDO            command prefix used when CH_APP_DIR is not writable (default: sudo)
#   GIT_AUTHOR         commit identity (default: "Vincent <1729065730@qq.com>")
#
# The manifest of feature branches is vincent/branches.txt next to this script's repo root.
# deploy prints a notice and a "stale" report without restarting processes.
# patch restarts and verifies the affected services after confirmation.
set -euo pipefail

if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  TOOLS_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
else # streamed over stdin ("stale --ssh"): only the read-only commands work
  SCRIPT_PATH="vincent-release.sh"; TOOLS_ROOT="$PWD"
fi
MANIFEST="${CH_MANIFEST:-$TOOLS_ROOT/vincent/branches.txt}"
CH_WORK="${CH_WORK:-$HOME/.codexhost-vincent}"
CH_SUDO="${CH_SUDO:-sudo}"
GIT_AUTHOR="${GIT_AUTHOR:-Vincent <1729065730@qq.com>}"
AUTHOR_NAME="${GIT_AUTHOR% <*}"
AUTHOR_EMAIL="${GIT_AUTHOR##*<}"; AUTHOR_EMAIL="${AUTHOR_EMAIL%>}"
APP_FILES=(host-runtime.mjs desktop-controller.mjs console-server.mjs renderer-extension.js console-web.js)

log() { printf '[vincent-release] %s\n' "$*" >&2; }
die() { printf '[vincent-release] error: %s\n' "$*" >&2; exit 1; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

repo() {
  if [[ -n "${CH_REPO:-}" ]]; then echo "$CH_REPO"; return; fi
  git -C "$TOOLS_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##' ||
    die "set CH_REPO to a codex-host clone"
}
g() { git -C "$(repo)" "$@"; }
remote_for() { # $1 = url pattern
  g remote -v | awk -v p="$1" '$2 ~ p && $3 == "(fetch)" { print $1; exit }'
}
upstream_remote() { echo "${CH_UPSTREAM_REMOTE:-$(remote_for 'BytePioneer-AI/codex-host')}"; }
fork_remote() { echo "${CH_FORK_REMOTE:-$(remote_for 'ump45nose/codex-host')}"; }

fetch_all() {
  local up fork; up="$(upstream_remote)"; fork="$(fork_remote)"
  [[ -n "$up" ]] || die "no remote for BytePioneer-AI/codex-host (set CH_UPSTREAM_REMOTE)"
  [[ -n "$fork" ]] || die "no remote for ump45nose/codex-host (set CH_FORK_REMOTE)"
  log "fetching $up (tags) and $fork"
  g fetch --quiet --tags "$up"
  g fetch --quiet "$fork"
}

latest_tag() { # newest stable vX.Y.Z tag reachable from upstream main
  local up; up="$(upstream_remote)"
  g tag --merged "$up/main" --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1
}

previous_release() { # newest vincent/release-vX.Y.Z (local or fork) older than $1
  local target="$1" fork v best=""
  fork="$(fork_remote)"
  while read -r v; do
    [[ "$v" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$v" != "$target" ]] || continue
    [[ "$(printf '%s\n%s\n' "$v" "$target" | sort -V | head -1)" == "$v" ]] || continue
    best="$v"
  done < <({ g for-each-ref --format='%(refname:short)' 'refs/heads/vincent/release-v*'
             g for-each-ref --format='%(refname:short)' "refs/remotes/$fork/vincent/release-v*" | sed "s#^$fork/##"; } |
           sed 's#^vincent/release-##' | sort -uV)
  [[ -n "$best" ]] || return 0
  if g rev-parse -q --verify "refs/heads/vincent/release-$best" >/dev/null; then echo "vincent/release-$best"
  else echo "$fork/vincent/release-$best"; fi
}

manifest_branches() { sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^[[:space:]]*$/d' -e 's/^[[:space:]]*//' "$MANIFEST"; }

manifest_ref() {
  if [[ "$1" =~ ^[0-9a-f]{40}$ ]]; then echo "$1"
  else echo "$2/$1"; fi
}

parse_common() {
  TAG=""; FRESH=false; SKIP_CONFLICTS=false; NO_TEST=false; RUST=false; DRY_RUN=false; ARTIFACTS=""; ALLOW_MISMATCH=false
  REST=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tag) TAG="$2"; shift ;;
      --skip-conflicts) SKIP_CONFLICTS=true ;;
      --fresh) FRESH=true ;;
      --no-test) NO_TEST=true ;;
      --rust) RUST=true ;;
      --dry-run) DRY_RUN=true ;;
      --artifacts) ARTIFACTS="$2"; shift ;;
      --allow-version-mismatch) ALLOW_MISMATCH=true ;;
      *) REST+=("$1") ;;
    esac
    shift
  done
}

cmd_audit() {
  [[ $# == 0 ]] || die "audit takes no arguments"
  local up fork tags tag upstream_commit b comment ref ancestor count cherry prs pr state cache="" suggestion
  up="$(upstream_remote)"; fork="$(fork_remote)"
  [[ -n "$up" && -n "$fork" ]] || die "audit requires upstream and fork remotes"
  [[ -f "$MANIFEST" ]] || die "manifest missing: $MANIFEST"
  # Query tags without fetching: audit must not update refs or write work files.
  tags="$(g ls-remote --tags "$up" 'refs/tags/v*')" || die "cannot read upstream tags"
  tag="$(printf '%s\n' "$tags" | awk '$2 ~ /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/ { sub(/^refs\/tags\//, "", $2); print $2 }' | sort -V | tail -1)"
  [[ -n "$tag" ]] || die "no stable upstream tag found"
  upstream_commit="$(printf '%s\n' "$tags" | awk -v t="refs/tags/$tag" '$2 == t { direct=$1 } $2 == t "^{}" { peeled=$1 } END { print peeled ? peeled : direct }')"
  g cat-file -e "$upstream_commit^{commit}" 2>/dev/null || die "$tag is not available locally; fetch upstream before audit"
  printf 'latest upstream tag: %s (%s); manifest refs use local Git objects, without fetching\n' "$tag" "$upstream_commit"
  local total=0 removable=0 retained=0
  while read -r b comment || [[ -n "$b" ]]; do
    case "$b" in ""|\#*) continue ;; esac
    ref="$(manifest_ref "$b" "$fork")"; ancestor=unknown; count=unknown; suggestion=保留
    if g rev-parse -q --verify "$ref^{commit}" >/dev/null; then
      ancestor=no
      if g merge-base --is-ancestor "$ref" "$upstream_commit"; then ancestor=yes; fi
      if cherry="$(g cherry "$upstream_commit" "$ref" 2>/dev/null)"; then
        count="$(printf '%s\n' "$cherry" | awk '/^\+/ { n++ } END { print n+0 }')"
        # git cherry omits merge commits, whose conflict resolutions may be unique.
        if [[ "$ancestor" == yes ]] || { [[ "$count" == 0 ]] && [[ "$(g rev-list --count --merges "$upstream_commit..$ref")" == 0 ]]; }; then suggestion=可删; fi
      fi
    fi
    prs=""
    for pr in $(printf '%s\n' "$comment" | { grep -Eio 'PR[[:space:]]*#[0-9]+|pr-[0-9]+' || true; } | sed 's/[^0-9]//g' | sort -nu); do
      state="$(printf '%s\n' "$cache" | awk -v p="$pr" '$1 == p { print $2; exit }')"
      if [[ -z "$state" ]]; then
        state="$(gh pr view "$pr" --repo BytePioneer-AI/codex-host --json state --jq .state 2>/dev/null)" || state=UNKNOWN
        [[ -n "$state" ]] || state=UNKNOWN
        cache="${cache}${pr} ${state}"$'\n'
      fi
      prs="${prs}${prs:+,}#${pr}:${state}"
    done
    printf '%s\tancestor=%s\tcherry_unaccepted=%s\tPR=%s\t建议=%s\n' "$b" "$ancestor" "$count" "${prs:-none}" "$suggestion"
    total=$((total + 1))
    if [[ "$suggestion" == 可删 ]]; then removable=$((removable + 1)); else retained=$((retained + 1)); fi
  done < "$MANIFEST"
  printf 'audit total=%s removable=%s retained=%s\n' "$total" "$removable" "$retained"
}

cmd_status() {
  fetch_all
  local tag fork; tag="$(latest_tag)"; fork="$(fork_remote)"
  echo "latest upstream tag: $tag"
  echo "last built tag:      $(cat "$CH_WORK/last-built-tag" 2>/dev/null || echo none)"
  for b in $(manifest_branches); do
    local ref state; ref="$(manifest_ref "$b" "$fork")"
    if ! g rev-parse -q --verify "$ref^{commit}" >/dev/null; then state="MISSING on fork"
    elif g merge-base --is-ancestor "$ref" "$tag"; then state="already in $tag (drop from manifest)"
    else state="$(g rev-list --count "$tag..$ref") commits to merge, $(g rev-list --count "$ref..$tag") behind"; fi
    printf '  %-46s %s\n' "$b" "$state"
  done
}

merge_ref() {
  local wt="$1" ref="$2" message="${3:-}" args=()
  [[ -z "$message" ]] || args=(-m "$message")
  local gw=(git -C "$wt" -c "user.name=$AUTHOR_NAME" -c "user.email=$AUTHOR_EMAIL" -c rerere.enabled=true -c rerere.autoupdate=true)
  "${gw[@]}" merge --no-ff --no-edit -q ${args[@]+"${args[@]}"} "$ref" && return 0
  # rerere can resolve and stage every conflict while merge still exits nonzero.
  [[ -f "$(git -C "$wt" rev-parse --absolute-git-dir)/MERGE_HEAD" ]] || return 1
  [[ -z "$(git -C "$wt" diff --name-only --diff-filter=U)" ]] || return 1
  "${gw[@]}" commit -q --no-edit
}

seed_rerere() {
  local wt="$1" cache entry file target
  cache="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)/rr-cache"
  mkdir -p "$cache"
  for entry in "$TOOLS_ROOT"/vincent/rr-cache/*; do
    [[ -d "$entry" ]] || continue
    mkdir -p "$cache/${entry##*/}"
    for file in "$entry"/*; do
      [[ -f "$file" ]] || continue
      target="$cache/${entry##*/}/${file##*/}"
      [[ -e "$target" ]] || cp "$file" "$target"
    done
  done
  return 0
}

merge_manifest() {
  local wt="$1" skip_conflicts="$2" strict="${3:-false}" fork b ref
  fork="$(fork_remote)"; skipped=()
  seed_rerere "$wt"
  while IFS= read -r b; do
    ref="$(manifest_ref "$b" "$fork")"
    if ! git -C "$wt" rev-parse -q --verify "$ref^{commit}" >/dev/null; then
      if $strict || [[ "$b" =~ ^[0-9a-f]{40}$ ]]; then die "missing manifest ref $ref"; fi
      log "skip $b: not on fork"; skipped+=("$b(missing)"); continue
    fi
    if git -C "$wt" merge-base --is-ancestor "$ref" HEAD; then log "skip $b: already contained"; continue; fi
    log "merging $b"
    if ! merge_ref "$wt" "$ref"; then
      git -C "$wt" diff --name-only --diff-filter=U | sed 's/^/    conflict: /' >&2
      if $skip_conflicts; then
        git -C "$wt" merge --abort; skipped+=("$b(conflict)"); continue
      fi
      die "conflict merging $b in $wt; rerere could not resolve it"
    fi
  done < <(manifest_branches)
}

ensure_release_npm() {
  local wt="$1" version
  version="$(cd "$wt" && node -p 'require("./package.json").packageManager')"
  [[ "$version" =~ ^npm@[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "packageManager must pin npm exactly"
  version="${version#npm@}"
  mkdir -p "$CH_WORK/npm-cache" "$CH_WORK/tmp" "$CH_WORK/cache" "$CH_WORK/node-gyp"
  export npm_config_cache="$CH_WORK/npm-cache" TMPDIR="$CH_WORK/tmp"
  export XDG_CACHE_HOME="$CH_WORK/cache" npm_config_devdir="$CH_WORK/node-gyp"
  NPM_CLI="$CH_WORK/npm/$version/node_modules/npm/bin/npm-cli.js"
  if [[ ! -f "$NPM_CLI" ]]; then
    log "preparing release npm $version"
    npm install --prefix "$CH_WORK/npm/$version" --ignore-scripts --no-package-lock --no-save --no-audit --no-fund "npm@$version" >/dev/null
  fi
  export PATH="$CH_WORK/npm/$version/node_modules/.bin:$PATH"
}

install_build_dependencies() {
  local wt="$1" started="$SECONDS" key marker="$1/node_modules/.vincent-release-dependencies"
  ensure_release_npm "$wt"
  key="$(cd "$wt" && { sha package.json package-lock.json; echo "$NPM_CLI"; } | sha | cut -d' ' -f1)"
  if [[ ! -f "$marker" || "$(cat "$marker")" != "$key" ]]; then
    log "npm ci ($(node "$NPM_CLI" --version))"
    (cd "$wt" && node "$NPM_CLI" ci --no-audit --no-fund >/dev/null)
    echo "$key" > "$marker"
  else log "dependencies unchanged; reusing node_modules"; fi
  log "dependencies: $((SECONDS - started))s"
}

build_app() { # Called inside the source checkout; output is a generated app/ tree.
  local output="$1" started="$SECONDS"
  log "build app + plugins (no Rust)"
  node "$NPM_CLI" run -s build:typescript
  node "$NPM_CLI" run -s build:renderer
  mkdir -p "$output"
  node packages/host-runtime/scripts/build-release.mjs --output "$output/host-runtime.mjs"
  node packages/desktop-control/scripts/build-release.mjs --output "$output/desktop-controller.mjs"
  node packages/console-server/scripts/build-release.mjs --output "$output/console-server.mjs"
  cp packages/renderer-extension/dist/production.js "$output/renderer-extension.js"
  cp packages/renderer-extension/dist/console.js "$output/console-web.js"
  node scripts/release/harness-plugins.mjs --output "$output/plugins"
  node --import tsx packages/web-server/scripts/build-release.ts --output "$output" \
    --platform "$(node -p process.platform)" --architecture "$(node -p process.arch)"
  log "build: $((SECONDS - started))s"
}

# WP2 prepares/validates PATCH_SRC's candidate before calling patch_build_diff.
patch_prepare_source() {
  local tag="$1" started="$SECONDS" up fork remote url
  mkdir -p "$CH_WORK/patch"
  CH_WORK="$(cd "$CH_WORK" && pwd)"; PATCH_SRC="$CH_WORK/patch/src"
  if [[ ! -d "$PATCH_SRC/.git" ]]; then
    [[ ! -e "$PATCH_SRC" ]] || die "patch source exists but is not a clone: $PATCH_SRC"
    git clone --quiet --shared --no-checkout --origin build-source "$(repo)" "$PATCH_SRC"
  fi
  git -C "$PATCH_SRC" fetch --quiet --no-tags "$(repo)" '+refs/tags/*:refs/tags/*' '+refs/remotes/*:refs/remotes/*'
  up="$(upstream_remote)"; fork="$(fork_remote)"
  [[ -n "$up" && -n "$fork" ]] || die "patch requires upstream and fork remotes"
  # Refresh only the build clone: dry-run may write CH_WORK, never the source repo.
  for remote in "$up" "$fork"; do
    url="$(g remote get-url "$remote")"
    git -C "$PATCH_SRC" fetch --quiet --tags --prune "$url" "+refs/heads/*:refs/remotes/$remote/*"
  done
  [[ ! -f "$PATCH_SRC/.git/MERGE_HEAD" ]] || git -C "$PATCH_SRC" merge --abort
  git -C "$PATCH_SRC" checkout --quiet --detach --force "$tag"
  merge_manifest "$PATCH_SRC" false true
  PATCH_CANDIDATE_COMMIT="$(git -C "$PATCH_SRC" rev-parse HEAD)"
  log "merge: $((SECONDS - started))s (candidate $PATCH_CANDIDATE_COMMIT)"
}

patch_build_at() (
  local commit="$1" destination="$2"
  git -C "$PATCH_SRC" checkout --quiet --detach --force "$commit"
  # Keep installed dependencies, but rebuild generated sources after switching refs.
  git -C "$PATCH_SRC" clean -ffdqx -e node_modules/ -e '**/node_modules/'
  install_build_dependencies "$PATCH_SRC"
  rm -rf "$CH_WORK/patch/build"
  (cd "$PATCH_SRC" && build_app "$CH_WORK/patch/build/app")
  mkdir -p "$destination"
  rm -rf "$destination/app"
  cp -R "$CH_WORK/patch/build/app" "$destination/app"
)

patch_diff() { # base app/, candidate app/, fresh output directory
  node --input-type=module - "$1" "$2" "$3" <<'NODE'
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [base, candidate, out] = process.argv.slice(2);
function files(root, relative = '', result = new Map()) {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) files(root, name, result);
    else if (entry.isFile()) result.set(name, createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex'));
    else throw new Error(`Unsupported build artifact: ${name}`);
  }
  return result;
}
const before = files(base), after = files(candidate), changes = [];
mkdirSync(path.join(out, 'files'), { recursive: true });
for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
  if (before.get(name) === after.get(name)) continue;
  const kind = !after.has(name) ? 'D' : before.has(name) ? 'M' : 'A';
  changes.push(`${kind} ${name}\n`);
  if (kind === 'D') continue;
  mkdirSync(path.dirname(path.join(out, 'files', name)), { recursive: true });
  copyFileSync(path.join(candidate, name), path.join(out, 'files', name));
}
writeFileSync(path.join(out, 'CHANGES'), changes.join(''));
NODE
}

patch_build_diff() { # release version (with or without v), next patch number
  local release="${1#v}" patch="$2" base_tag="v${1#v}" base key
  [[ -n "${PATCH_CANDIDATE_COMMIT:-}" && -d "${PATCH_SRC:-}/.git" ]] || die "prepare the patch candidate first"
  base="$CH_WORK/patch/base/$base_tag"
  key="$(git -C "$PATCH_SRC" rev-parse "$base_tag^{commit}") $PATCH_SRC $(node --version)"
  if [[ ! -d "$base/app" || "$(cat "$base/SOURCE" 2>/dev/null || true)" != "$key" ]]; then
    log "building baseline $base_tag"
    rm -f "$base/SOURCE"
    patch_build_at "$base_tag" "$base"
    echo "$key" > "$base/SOURCE"
  else log "reusing baseline $base_tag"; fi
  patch_build_at "$PATCH_CANDIDATE_COMMIT" "$CH_WORK/patch/candidate"
  mkdir -p "$CH_WORK/patch/out"
  PATCH_ARTIFACTS="$(mktemp -d "$CH_WORK/patch/out/$(date +%Y%m%d-%H%M%S)-XXXXXX")"
  patch_diff "$base/app" "$CH_WORK/patch/candidate/app" "$PATCH_ARTIFACTS"
  printf 'release=%s\npatch=%s\ncandidate_commit=%s\n' "$release" "$patch" "$PATCH_CANDIDATE_COMMIT" > "$PATCH_ARTIFACTS/BUILD_INFO"
  printf '%s\n' "${PATCH_CANDIDATE_REFS:-}" > "$PATCH_ARTIFACTS/CANDIDATE_REFS"
  (cd "$PATCH_ARTIFACTS" && find . -type f ! -name SHA256SUMS | LC_ALL=C sort | while IFS= read -r f; do sha "$f"; done > SHA256SUMS)
  log "patch artifacts: $PATCH_ARTIFACTS ($(wc -l < "$PATCH_ARTIFACTS/CHANGES" | tr -d ' ') changed paths)"
}

patch_target_run() { # Run the same target-side function locally or over SSH, without copying files.
  local target="$1" command remote; shift
  if [[ "$target" == local ]]; then "$@"; return; fi
  printf -v command '%q ' "$@"
  printf -v remote '%q' "bash -s -- __patch_target $command"
  ssh "$target" "bash -lc $remote" < "$SCRIPT_PATH"
}

patch_target_version() {
  local app version; app="$(detect_app_dir)"
  version="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$app/codexhost-distribution.json")" || return 1
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-vincent\.[0-9]+(\+patch\.[0-9]+)?$ ]] || die "not an installed fork release: $version"
  printf '%s\t%s\n' "$app" "$version"
}

patch_collect_targets() {
  PATCH_APPS=(); PATCH_VERSIONS=(); PATCH_RELEASE=""; PATCH_NUMBER=1
  local target info app version release number
  for target in "${PATCH_TARGETS[@]}"; do
    info="$(patch_target_run "$target" patch_target_version)" || die "cannot read installed fork release on $target"
    IFS=$'\t' read -r app version <<< "$info"; release="${version%%+patch.*}"
    [[ -z "$PATCH_RELEASE" || "$PATCH_RELEASE" == "$release" ]] || die "targets have different releases ($PATCH_RELEASE, $release); run macauto update codex-host first"
    PATCH_RELEASE="$release"; PATCH_APPS+=("$app"); PATCH_VERSIONS+=("$version")
    number=0; [[ "$version" != *+patch.* ]] || number="${version##*+patch.}"
    (( 10#$number + 1 <= PATCH_NUMBER )) || PATCH_NUMBER=$((10#$number + 1))
  done
  PATCH_UPSTREAM_TAG="v${PATCH_RELEASE%%-vincent.*}"
}

patch_files() { # Snapshot/plan are read-only; apply/restore own the patch ledger and one-deployment backup.
  ${run[@]+"${run[@]}"} node --input-type=module - "$@" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const [mode, ...args] = process.argv.slice(2), metadata = 'codexhost-distribution.json';
const digest = data => createHash('sha256').update(data).digest('hex');
const skip = reason => { console.error(`[vincent-release] ${reason}; skipping target`); process.exit(3); };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
const put = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.vincent-${process.pid}-${randomUUID()}`;
  try { fs.writeFileSync(temporary, data, { flag: 'wx', mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
};
function file(root, name) {
  if (!name || name.includes('\n') || name.includes('\r') || name.includes('\\') || path.isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw Error(`Unsafe patch path: ${name}`);
  let target = root;
  for (const part of name.split('/')) { target = path.join(target, part); if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error(`Symlink in patch path: ${name}`); }
  return target;
}
function state(root, name) {
  const target = file(root, name);
  if (!fs.existsSync(target)) return null;
  return { data: fs.readFileSync(target).toString('base64'), mode: fs.statSync(target).mode & 0o777 };
}
const hash = value => value === null ? 'ABSENT' : digest(Buffer.from(value.data, 'base64'));
function writeState(root, name, value) {
  const target = file(root, name);
  if (value === null) fs.rmSync(target, { force: true });
  else { put(target, Buffer.from(value.data, 'base64')); fs.chmodSync(target, value.mode); }
  if (hash(state(root, name)) !== hash(value)) throw Error(`File verification failed: ${name}`);
}
function changes(root) {
  return new Map(lines(path.join(root, 'CHANGES')).map(line => {
    if (!/^[AMD] /.test(line) || line.slice(2) === metadata) throw Error(`Invalid patch change: ${line}`);
    file(root, line.slice(2)); return [line.slice(2), line[0]];
  }));
}
function checksums(root) {
  const names = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name))).filter(name => name !== 'SHA256SUMS').sort();
  put(path.join(root, 'SHA256SUMS'), names.map(name => `${digest(fs.readFileSync(path.join(root, name)))}  ${name}\n`).join(''));
}
function restore(backup, guard = true) {
  const app = fs.readFileSync(path.join(backup, 'APP_DIR'), 'utf8').trim(), info = json(path.join(backup, 'PATCH_BACKUP.json'));
  if (guard && json(path.join(app, metadata)).version !== info.after) throw Error('Installed version changed; refusing rollback');
  for (const [name, value] of Object.entries(info.before)) writeState(app, name, value === null ? null : state(path.join(backup, 'files'), name));
  writeState(app, metadata, state(backup, metadata));
  fs.rmSync(info.record, { recursive: true, force: true });
  if (fs.existsSync(path.join(backup, 'PATCH_RECORD'))) fs.cpSync(path.join(backup, 'PATCH_RECORD'), info.record, { recursive: true, preserveTimestamps: true });
}
if (mode === 'inspect') {
  const [app, version, release, request] = args, distribution = state(app, metadata);
  if (JSON.parse(Buffer.from(distribution.data, 'base64')).version !== version) throw Error('Installed version changed while planning');
  const record = path.join(path.dirname(app), 'codexhost-patch', release), active = version.includes('+patch.');
  if (active && (!fs.existsSync(path.join(record, metadata)) || !fs.existsSync(path.join(record, 'EXPECTED')) || !fs.existsSync(path.join(record, 'ABSENT')) || json(path.join(record, metadata)).version !== release)) throw Error('Missing or stale patch originals; cannot safely continue');
  const expected = active ? Object.fromEntries(lines(path.join(record, 'EXPECTED')).map(line => [line.slice(65), line.slice(0, 64).trim()])) : {}, absent = new Set(lines(path.join(record, 'ABSENT')));
  const names = [...new Set([...Object.keys(expected), ...request.split('\n').filter(Boolean)])].sort(), originals = Object.create(null);
  const before = Object.fromEntries(names.map(name => [name, hash(state(app, name))]));
  for (const [name, expectedHash] of Object.entries(expected)) {
    if (before[name] !== expectedHash) throw Error(`Installed patched file changed: ${name}`);
    originals[name] = absent.has(name) ? null : state(path.join(record, 'originals'), name);
    if (!absent.has(name) && originals[name] === null) throw Error(`Missing original patch file: ${name}`);
  }
  process.stdout.write(JSON.stringify({ app, version, release, distribution, originalDistribution: active ? state(record, metadata) : distribution, before, originals, active }));
} else if (mode === 'plan') {
  const [source, destination = '', undo = 'false'] = args, snapshot = JSON.parse(fs.readFileSync(3, 'utf8')), wanted = undo === 'true' ? new Map() : changes(source), plan = [];
  for (const name of Object.keys(snapshot.before)) {
    const kind = wanted.get(name), desired = kind ? (kind === 'D' ? null : state(path.join(source, 'files'), name)) : snapshot.originals[name];
    if (kind && kind !== 'D' && desired === null) throw Error(`Missing candidate file: ${name}`);
    if (desired === undefined || hash(desired) === snapshot.before[name]) continue;
    plan.push(`${desired === null ? 'D' : snapshot.before[name] === 'ABSENT' ? 'A' : 'M'} ${name}\n`);
    if (destination && desired !== null) writeState(path.join(destination, 'files'), name, desired);
  }
  if (destination) {
    const next = snapshot.version.includes('+patch.') ? Number(snapshot.version.split('+patch.')[1]) + 1 : 1;
    snapshot.after = undo === 'true' ? snapshot.release : `${snapshot.release}+patch.${next}`; snapshot.undo = undo === 'true';
    put(path.join(destination, 'STATE.json'), JSON.stringify(snapshot));
    put(path.join(destination, 'CHANGES'), plan.join(''));
    put(path.join(destination, 'BUILD_INFO'), `release=${snapshot.release}\npatch=${next}\nundo=${undo}\n`); checksums(destination);
  }
  process.stdout.write(plan.join(''));
} else if (mode === 'apply') {
  const [source, backupPrefix] = args, info = json(path.join(source, 'STATE.json')), app = info.app, recordRoot = path.join(path.dirname(app), 'codexhost-patch'), record = path.join(recordRoot, info.release);
  if (hash(state(app, metadata)) !== hash(info.distribution)) skip('Installed version or metadata changed');
  for (const [name, expected] of Object.entries(info.before)) if (hash(state(app, name)) !== expected) skip(`Installed file changed: ${name}`);
  const before = Object.fromEntries([...changes(source)].map(([name]) => [name, state(app, name)]));
  fs.mkdirSync(path.dirname(backupPrefix), { recursive: true });
  const backup = fs.mkdtempSync(backupPrefix);
  put(path.join(backup, 'APP_DIR'), app + '\n'); writeState(backup, metadata, info.distribution);
  put(path.join(backup, 'PATCH_BACKUP.json'), JSON.stringify({ before, record, after: info.after }));
  put(path.join(backup, 'ABSENT'), Object.keys(before).filter(name => before[name] === null).join('\n') + '\n');
  for (const [name, value] of Object.entries(before)) if (value !== null) writeState(path.join(backup, 'files'), name, value);
  if (fs.existsSync(record)) fs.cpSync(record, path.join(backup, 'PATCH_RECORD'), { recursive: true, preserveTimestamps: true });
  checksums(backup);
  try {
    if (!info.active) { fs.rmSync(record, { recursive: true, force: true }); writeState(record, metadata, info.distribution); put(path.join(record, 'ABSENT'), ''); put(path.join(record, 'EXPECTED'), ''); }
    const expected = Object.fromEntries(lines(path.join(record, 'EXPECTED')).map(line => [line.slice(65), line.slice(0, 64).trim()])), absent = new Set(lines(path.join(record, 'ABSENT')));
    for (const [name, kind] of changes(source)) {
      if (!Object.hasOwn(expected, name)) { if (before[name] === null) absent.add(name); else writeState(path.join(record, 'originals'), name, before[name]); }
      const desired = kind === 'D' ? null : state(path.join(source, 'files'), name);
      writeState(app, name, desired); expected[name] = hash(desired);
    }
    if (info.undo) { writeState(app, metadata, info.originalDistribution); fs.rmSync(record, { recursive: true, force: true }); }
    else {
      put(path.join(record, 'ABSENT'), [...absent].sort().map(name => name + '\n').join(''));
      put(path.join(record, 'EXPECTED'), Object.keys(expected).sort().map(name => `${expected[name].padEnd(64)} ${name}\n`).join(''));
      const distribution = JSON.parse(Buffer.from(info.distribution.data, 'base64')); distribution.version = info.after;
      put(path.join(app, metadata), JSON.stringify(distribution, null, 2) + '\n');
    }
    if (json(path.join(app, metadata)).version !== info.after) throw Error('Patch version verification failed');
    for (const entry of fs.readdirSync(recordRoot, { withFileTypes: true })) {
      const stale = path.join(recordRoot, entry.name, metadata);
      if (entry.isDirectory() && entry.name !== info.release && fs.existsSync(stale) && json(stale).version !== info.release) fs.rmSync(path.dirname(stale), { recursive: true, force: true });
    }
  } catch (error) {
    try {
      const version = json(path.join(app, metadata)).version;
      if (version !== info.version && version !== info.after) throw Error('Installed version changed; refusing rollback');
      restore(backup, false);
    } catch (rollbackError) { console.error(`[vincent-release] ${error.message}; rollback failed: ${rollbackError.message}`); process.exit(4); }
    console.error(`[vincent-release] ${error.message}; deployment rolled back`); process.exit(2);
  }
  process.stdout.write(backup + '\t' + info.after + '\n');
} else if (mode === 'restore') restore(args[0]);
else throw Error(`Unknown patch file operation: ${mode}`);
NODE
}

patch_plan_targets() {
  local undo="${1:-false}" i snapshot request destination changes
  PATCH_TARGET_ARTIFACTS=(); PATCH_TARGET_CHANGES=(); PATCH_HAS_CHANGES=false
  request=""; [[ "$undo" == true ]] || request="$(sed 's/^[AMD] //' "$PATCH_ARTIFACTS/CHANGES")"
  $DRY_RUN || mkdir -p "$CH_WORK/patch/out"
  for ((i=0; i<${#PATCH_TARGETS[@]}; i++)); do
    snapshot="$(patch_target_run "${PATCH_TARGETS[$i]}" patch_files inspect "${PATCH_APPS[$i]}" "${PATCH_VERSIONS[$i]}" "$PATCH_RELEASE" "$request")" || return 1
    destination=""; $DRY_RUN || destination="$(mktemp -d "$CH_WORK/patch/out/target-$i-XXXXXX")"
    changes="$(printf '%s' "$snapshot" | patch_files plan "${PATCH_ARTIFACTS:-}" "$destination" "$undo" 3<&0)" || return 1
    PATCH_TARGET_ARTIFACTS+=("$destination"); PATCH_TARGET_CHANGES+=("$changes")
    if [[ -n "$changes" || ( "$undo" == true && "${PATCH_VERSIONS[$i]}" == *+patch.* ) ]]; then PATCH_HAS_CHANGES=true; fi
  done
}
patch_prepare_undo() { PATCH_ARTIFACTS=""; patch_plan_targets true; }
patch_deploy_targets() {
  local i target result backup version status failed=0
  PATCH_BACKUPS=(); PATCH_DEPLOYED_VERSIONS=(); PATCH_STATUSES=()
  for ((i=0; i<${#PATCH_TARGETS[@]}; i++)); do
    target="${PATCH_TARGETS[$i]}"
    if [[ ! -s "${PATCH_TARGET_ARTIFACTS[$i]}/CHANGES" ]] && { [[ "${PATCH_VERSIONS[$i]}" != *+patch.* ]] || ! grep -qx 'undo=true' "${PATCH_TARGET_ARTIFACTS[$i]}/BUILD_INFO"; }; then
      PATCH_STATUSES[$i]='already up to date'; log "$target: ${PATCH_STATUSES[$i]}"; continue
    fi
    if { if [[ "$target" == local ]]; then result="$(cmd_deploy local --artifacts "${PATCH_TARGET_ARTIFACTS[$i]}")"; else result="$(cmd_deploy ssh "$target" --artifacts "${PATCH_TARGET_ARTIFACTS[$i]}")"; fi; }; then
      IFS=$'\t' read -r backup version <<< "$result"; PATCH_BACKUPS[$i]="$backup"; PATCH_DEPLOYED_VERSIONS[$i]="$version"
      PATCH_STATUSES[$i]='replaced'
      if ! patch_after_deploy "$target" "${PATCH_APPS[$i]}" "${PATCH_TARGET_ARTIFACTS[$i]}" "$backup" "$version" "$i"; then failed=2; fi
    else
      status=$?
      case "$status" in
        2) PATCH_STATUSES[$i]='rolled back: deployment failed'; failed=2 ;;
        4) PATCH_STATUSES[$i]='failed: automatic rollback refused or failed'; failed=2 ;;
        *) PATCH_STATUSES[$i]='skipped: deployment preflight failed'; (( failed != 0 )) || failed=1 ;;
      esac
    fi
    log "$target: ${PATCH_STATUSES[$i]}"
  done
  return "$failed"
}

patch_check_compatibility() { # Candidate versus the installed fork tag, before any build.
  local base="v$PATCH_RELEASE" up; up="$(upstream_remote)"
  [[ -n "$up" ]] || die "no upstream remote for patch compatibility checks"
  node --input-type=module - "$PATCH_SRC" "$base" "$PATCH_CANDIDATE_COMMIT" "$PATCH_UPSTREAM_TAG" "$up" <<'NODE'
import { execFileSync } from 'node:child_process';
const [cwd, base, candidate, tag, upstream] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const refuse = reason => { console.error(`[vincent-release] error: ${reason}; use a formal release`); process.exit(1); };
git('rev-parse', '--verify', `${upstream}/main`);
const upstreamNew = new Set(git('rev-list', `--remotes=${upstream}/*`, `^${tag}`).split('\n'));
// Features already shipped in the installed fork may have since been merged upstream.
if (git('rev-list', candidate, `^${base}`, `^${tag}`).split('\n').some(commit => upstreamNew.has(commit) && commit)) refuse(`candidate introduces upstream commits outside ${tag}`);
for (const name of git('diff', '--name-only', '-z', base, candidate).split('\0').filter(Boolean)) {
  if (/^(?:crates\/|\.cargo\/|Cargo\.(?:toml|lock)$|scripts\/release\/)/.test(name) || /(?:^|\/)npm-shrinkwrap\.json$/.test(name)) refuse(`native or packaging layout changed: ${name}`);
  if (!/(?:^|\/)package(?:-lock)?\.json$/.test(name)) continue;
  let before, after;
  try { before = JSON.parse(git('show', `${base}:${name}`)); after = JSON.parse(git('show', `${candidate}:${name}`)); }
  catch { refuse(`npm metadata file added or removed: ${name}`); }
  const fields = ['name', 'version', 'private', 'type', 'main', 'module', 'types', 'typings', 'browser', 'bin', 'files', 'exports', 'imports', 'os', 'cpu', 'libc', 'engines', 'scripts', 'packageManager', 'publishConfig', 'workspaces', 'lockfileVersion'];
  const metadata = value => Object.fromEntries(fields.filter(key => key in value).map(key => [key, value[key]]));
  if (JSON.stringify(metadata(before)) !== JSON.stringify(metadata(after)) || JSON.stringify(metadata(before.packages?.[''] ?? {})) !== JSON.stringify(metadata(after.packages?.[''] ?? {}))) refuse(`npm metadata changed: ${name}`);
}
if (JSON.parse(git('show', `${candidate}:package.json`)).version !== tag.slice(1)) refuse(`candidate package version does not match ${tag}`);
NODE
}

patch_candidate_refs() { # Verify pushed branch tips read-only, then fingerprint the exact build inputs.
  local fork remote_refs branch ref commit pushed
  fork="$(fork_remote)"; [[ -n "$fork" ]] || die "no fork remote for candidate verification"
  [[ -f "$MANIFEST" ]] || die "candidate manifest missing: $MANIFEST"
  remote_refs="$(g ls-remote --heads "$fork")" || die "cannot verify pushed candidate branches"
  {
    git -C "$PATCH_SRC" rev-parse "v$PATCH_RELEASE^{commit}" "$PATCH_UPSTREAM_TAG^{commit}" || exit 1
    while IFS= read -r branch; do
      ref="$(manifest_ref "$branch" "$fork")"; commit="$(git -C "$PATCH_SRC" rev-parse "$ref^{commit}")" || exit 1
      if [[ ! "$branch" =~ ^[0-9a-f]{40}$ ]]; then
        pushed="$(printf '%s\n' "$remote_refs" | awk -v ref="refs/heads/$branch" '$2 == ref {print $1}')"
        [[ "$pushed" == "$commit" ]] || die "candidate ref $ref changed after fetching; rerun patch to refresh it"
      fi
      printf '%s %s\n' "$branch" "$commit"
    done < <(manifest_branches)
  } | sha | cut -d' ' -f1
}

patch_restart_actions() { # Stable action tokens consumed by WP4; multiple file classes take their union.
  local file
  {
    # Every actual patch changes the version displayed by a running Console.
    echo console
    while IFS= read -r file; do
      [[ -n "$file" ]] || continue
      case "${file#* }" in
        renderer-extension.js|desktop-controller.mjs) echo desktop ;;
        console-web.js|console-server.mjs) echo console ;;
        web/*|web-modules/*|web-server.mjs) echo web ;;
        *) printf 'desktop\nhost\n' ;;
      esac
    done < "$1"
  } | LC_ALL=C sort -u
}

patch_target_runtime() {
  local steps=() a=$'\n'"$2"$'\n'
  [[ "$a" == *$'\n'host$'\n'* ]] && steps+=("Host and Remote Host (interrupts running sessions)")
  [[ "$a" == *$'\n'web$'\n'* ]] && steps+=("Web if running")
  [[ "$a" == *$'\n'console$'\n'* ]] && steps+=("Console if running")
  [[ "$a" == *$'\n'desktop$'\n'* ]] && steps+=("Codex Desktop")
  printf '  Restart: %s\n  Sessions before restart:\n' "$(IFS=,; echo "${steps[*]}" | sed 's/,/, /g')"
  patch_target_restart sessions "$1" ''
}

patch_target_restart() { # Snapshot and restart use the installed public CLI and its readiness records.
  node --input-type=module - "$@" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const [mode, app, actionList, version = '', expected = '{}', original = '{}'] = process.argv.slice(2);
const actions = new Set(actionList.split('\n').filter(Boolean)), before = JSON.parse(original), env = { ...process.env };
for (const key of ['CODEXHOST_RUNTIME_ENDPOINT', 'CODEXHOST_RUNTIME_TOKEN', 'CODEXHOST_THREAD_ID', 'CODEX_THREAD_ID', 'CODEXHOST_CLIENT_TOKEN', 'CODEXHOST_CLIENT_TOKEN_FILE']) delete env[key];
// A managed SSH login profile points at the Remote Host data root; target the local installation like the npm launcher does.
if (env.CODEXHOST_REMOTE_SSH_MANAGED === '1') {
  for (const key of ['CODEX_INSTALL_DIR', 'CODEXHOST_DATA_DIR', 'CODEXHOST_DEFAULT_AGENT', 'CODEXHOST_HOST_NODE_PATH', 'CODEXHOST_HOST_RUNTIME_PATH', 'CODEXHOST_REMOTE_SSH_MANAGED', 'CODEXHOST_STOCK_CODEX_PATH']) delete env[key];
}
const data = path.resolve(env.CODEXHOST_DATA_DIR || path.join(os.homedir(), '.codexhost'));
const cli = path.join(app, '../bin/codexhost'), execute = promisify(execFile);
env.CODEXHOST_CLI_NODE_PATH = process.execPath;
env.CODEXHOST_NPM_NODE_PATH = process.execPath;
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const command = async (file, args) => (await execute(file, args, { env, timeout: 150_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const run = (...args) => command(cli, args);
const json = text => { for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) { try { return JSON.parse(text.slice(0, end + 1)); } catch {} } throw Error('CLI returned invalid JSON'); };
const wait = async (label, probe, timeout = 45_000, failure = () => null) => {
  const deadline = Date.now() + timeout; let detail = '';
  do { const error = failure(); if (error) throw error; try { if (await probe()) return; } catch (error) { detail = error.message; } await new Promise(resolve => setTimeout(resolve, 200)); } while (Date.now() < deadline);
  throw Error(`${label} did not become ready${detail ? ': ' + detail : ''}`);
};
const health = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${env.CODEXHOST_CONSOLE_PORT || 4399}/api/health`, { signal: AbortSignal.timeout(1500) });
    const value = await response.json();
    if (!response.ok || value.service !== 'codexhost-console' || path.resolve(value.appDirectory) !== path.resolve(app) || !alive(value.pid)) throw Error('Console endpoint belongs to another installation or is not ready');
    return { pid: value.pid, version: value.version };
  } catch (error) { if (error.cause?.code === 'ECONNREFUSED') return null; throw error; }
};
const remoteStatus = async () => json(await command(process.execPath, [path.join(app, 'host-runtime.mjs'), '--codexhost-remote', 'status']));
const socketPids = async socket => {
  try { return (await command('lsof', ['-t', '--', socket])).split(/\s+/).filter(Boolean).map(Number).sort((a, b) => a - b); }
  catch (error) { if (error.code === 1 && !error.stdout?.trim()) return []; throw error; }
};
const sessions = async () => {
  const running = [], seen = new Set(); let cursor;
  do {
    const page = json(await run('thread', 'list', '--format', 'json', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])));
    for (const thread of page.threads) if (thread.status === 'running') running.push(thread);
    if (page.nextCursor && seen.has(page.nextCursor)) throw Error('Thread pagination did not advance');
    cursor = page.nextCursor;
    seen.add(cursor);
  } while (cursor);
  return running;
};
const desktop = async () => {
  const result = json(await run('inspect', '--json'));
  if (result.desktop?.installRoot !== '/Applications/ChatGPT.app') throw Error('Expected Desktop at /Applications/ChatGPT.app');
  const status = read(path.join(data, 'diagnostics/desktop-controller-v1.json'));
  const controller = alive(status?.pid) ? status.pid : null;
  if (controller) {
    const commandLine = await command('ps', ['-p', String(controller), '-o', 'command=']);
    const entry = ' ' + path.join(app, 'desktop-controller.mjs');
    if (!commandLine.includes(entry + ' ') && !commandLine.endsWith(entry)) throw Error('Desktop Controller belongs to another installation');
  }
  return { pids: result.desktop.processIds.filter(alive), launcher: result.runtime?.launcherPid, controller, ready: result.runtime?.running === true };
};
const snapshot = async () => {
  const hostRecord = read(path.join(data, 'shared-host-ready.json')), webRecord = read(path.join(data, 'web-service-ready.json'));
  const host = hostRecord && alive(hostRecord.pid) ? { pid: hostRecord.pid, runtime: hostRecord.runtime, executable: hostRecord.executable } : null;
  const web = webRecord && alive(webRecord.pid) && alive(webRecord.web_pid) ? { pid: webRecord.pid, child: webRecord.web_pid, runtime: webRecord.runtime, address: webRecord.address } : null;
  const remote = actions.has('host') ? await remoteStatus() : null;
  return { host, web, desktop: actions.has('desktop') ? await desktop() : null, console: await health(),
    remote: remote ? { state: remote.state, runtime: remote.runtime, hostRuntimePath: remote.hostRuntimePath, pids: remote.runtime.state === 'running' ? await socketPids(remote.runtime.socketPath) : [] } : null,
    sessions: actions.has('desktop') && !actions.has('host') && host ? (await sessions()).map(thread => thread.threadId) : [] };
};
try {
  if (mode === 'sessions') { process.stdout.write(JSON.stringify({ threads: await sessions() }) + '\n'); process.exit(0); }
  if (mode === 'snapshot') { process.stdout.write(JSON.stringify(await snapshot())); process.exit(0); }
  if (mode !== 'restart') throw Error(`Unknown runtime operation: ${mode}`);
  // Aqua startup sockets need a short path; build temporaries stay in CH_WORK.
  if (process.platform === 'darwin') env.TMPDIR = '/tmp';
  const current = await snapshot(), node = before.host?.executable || current.host?.executable || ['/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node', path.join(app, '../runtime/node'), process.execPath].find(file => fs.existsSync(file));
  env.CODEXHOST_HOST_RUNTIME_PATH = path.join(app, 'host-runtime.mjs'); env.CODEXHOST_HOST_NODE_PATH = node;
  const hostArgs = ['--node', node, '--host-runtime', path.join(app, 'host-runtime.mjs'), '--data', data];
  const webArgs = ['--node', process.execPath, '--host-node', node, '--host-runtime', path.join(app, 'host-runtime.mjs'), '--web-runtime', path.join(app, 'web-server.mjs'), '--data', data];
  if (actions.has('desktop')) {
    const pids = [...new Set([current.desktop.controller, ...current.desktop.pids, current.desktop.launcher].filter(alive))];
    // Desktop exit makes the native Launcher stop even a stalled Controller within its grace period.
    let stop = pids;
    if (alive(current.desktop.launcher)) stop = current.desktop.pids.length ? current.desktop.pids : alive(current.desktop.controller) ? [current.desktop.controller] : [current.desktop.launcher];
    for (const pid of stop) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await wait('Desktop shutdown', () => { const running = pids.filter(alive); if (running.length) throw Error(`processes still running: ${running.join(', ')}`); return true; }, 15_000);
  }
  if (actions.has('host')) {
    if (current.remote.state !== 'not-installed') {
      if (path.resolve(current.remote.hostRuntimePath) !== path.join(app, 'host-runtime.mjs')) throw Error('Remote Host points at another installation');
      await command(node, [path.join(app, 'host-runtime.mjs'), '--codexhost-remote', 'stop']);
    }
    await run('host', 'stop', ...hostArgs);
    await run('host', 'ensure', ...hostArgs);
    if (current.remote.state !== 'not-installed') await command(node, [path.join(app, 'host-runtime.mjs'), '--codexhost-remote', 'start']);
  }
  if (actions.has('web') && before.web) { await run('web-service', 'stop', ...webArgs); await run('web-service', 'ensure', ...webArgs); }
  if (actions.has('console') && before.console) {
    await command(process.execPath, [path.join(app, 'console-server.mjs'), 'stop']);
    await command(process.execPath, [path.join(app, 'console-server.mjs'), 'ensure']);
  }
  if (actions.has('desktop')) {
    const launchStarted = Date.now();
    const child = spawn(cli, ['launch', '--node', node], { detached: true, stdio: 'ignore', env });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    let launched;
    await wait('Desktop integration', async () => {
      const result = await desktop(), status = read(path.join(data, 'diagnostics/desktop-controller-v1.json'));
      if (result.ready && alive(result.launcher) && result.launcher !== current.desktop.launcher && result.controller !== current.desktop.controller && status?.pid === result.controller && status.startedAt >= launchStarted) launched = result;
      return launched && result.ready && result.launcher === launched.launcher && result.controller === launched.controller && result.pids.length && result.pids.every(pid => !current.desktop.pids.includes(pid)) && alive(result.launcher) && alive(result.controller) && status?.pid === result.controller && status.startedAt >= launchStarted && status.renderer?.state === 'installed';
    }, 120_000, () => {
      // The npm CLI exits 0 at Launcher readiness, before Renderer/CDP installation completes.
      if (child.signalCode !== null || (child.exitCode !== null && child.exitCode !== 0)) {
        const record = read(path.join(data, 'diagnostics/launcher-startup-v1.json'))?.records.find(record => record.startedAtMs >= launchStarted && (!launched || record.pid === launched.launcher));
        return Error(`Desktop launch exited (${child.signalCode || child.exitCode})${record?.error ? ': ' + record.error : ''}`);
      }
      if (launched && (!alive(launched.launcher) || !alive(launched.controller))) return Error('Desktop Launcher or Controller exited before Renderer integration became ready');
      return null;
    });
  }
  if (read(path.join(app, 'codexhost-distribution.json'))?.version !== version) throw Error('Installed version changed during restart');
  for (const [name, wanted] of Object.entries(JSON.parse(expected))) {
    const file = path.join(app, name), actual = fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'ABSENT';
    if (actual !== wanted) throw Error(`Installed file hash mismatch: ${name}`);
  }
  if (actions.has('host')) {
    await wait('Host', () => { const host = read(path.join(data, 'shared-host-ready.json')); return host && alive(host.pid) && host.pid !== current.host?.pid && host.runtime === path.join(app, 'host-runtime.mjs'); });
    await run('host', 'info', '--format', 'json');
    if (current.remote.state !== 'not-installed') {
      const remote = await remoteStatus(), pids = await socketPids(remote.runtime.socketPath);
      if (remote.runtime.state !== 'running' || !pids.length || pids.some(pid => current.remote.pids.includes(pid))) throw Error('Remote Host did not change process and become ready');
    }
  }
  if (actions.has('web') && before.web) await wait('Web', async () => {
    const web = read(path.join(data, 'web-service-ready.json'));
    if (!web || !alive(web.pid) || !alive(web.web_pid) || web.web_pid === current.web?.child || web.runtime !== path.join(app, 'web-server.mjs')) return false;
    const address = new URL(web.address), login = new URL(web.loginUrl);
    if (login.origin !== address.origin) throw Error('Web login URL belongs to another endpoint');
    const token = login.searchParams.get('token');
    const response = await fetch(address, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(1500) }); return response.ok;
  });
  if (before.console) {
    const consoleHealth = await health();
    if (!consoleHealth || consoleHealth.version !== version || consoleHealth.pid === before.console.pid) throw Error(`Console health version/process mismatch (expected ${version}, received ${consoleHealth?.version || 'unavailable'})`);
  }
  if (actions.has('desktop') && !actions.has('host')) {
    const host = read(path.join(data, 'shared-host-ready.json'));
    if (before.host && (host?.pid !== before.host.pid || !alive(host.pid))) throw Error('Desktop restart changed the Host process');
    const running = new Set((await sessions()).map(thread => thread.threadId));
    if (before.sessions.some(id => !running.has(id))) throw Error('A previously running session stopped during Desktop restart');
  }
  console.error(`[vincent-release] verified ${version}: file hashes, Console health when running, restarted process identities and readiness${actions.has('desktop') && !actions.has('host') ? ', Host and running sessions preserved' : ''}`);
} catch (error) { console.error(`[vincent-release] ${error.message}`); process.exitCode = 1; }
NODE
}

patch_target_restore() {
  local app="$1" backup="$2" expected="$3" version
  version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$app/codexhost-distribution.json")" || return 1
  [[ "$version" == "$expected" ]] || { log "installed version changed to $version; refusing automatic rollback"; return 1; }
  cmd_rollback "$backup" || return 1
  node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$app/codexhost-distribution.json"
}

patch_after_deploy() {
  local target="$1" app="$2" artifacts="$3" backup="$4" version="$5" index="$6" actions expected before="" restored
  actions="$(patch_restart_actions "$artifacts/CHANGES")"
  if expected="$(node -e 'const fs=require("fs"),path=require("path"),crypto=require("crypto"),root=process.argv[1]; console.log(JSON.stringify(Object.fromEntries(fs.readFileSync(path.join(root,"CHANGES"),"utf8").split("\n").filter(Boolean).map(line=>[line.slice(2),line[0]==="D"?"ABSENT":crypto.createHash("sha256").update(fs.readFileSync(path.join(root,"files",line.slice(2)))).digest("hex")]))))' "$artifacts")" &&
    before="$(patch_target_run "$target" patch_target_restart snapshot "$app" "$actions")" && patch_target_run "$target" patch_target_restart restart "$app" "$actions" "$version" "$expected" "$before"; then
    PATCH_STATUSES[$index]="replaced: $version; restart and verification passed"; return 0
  fi
  if restored="$(patch_target_run "$target" patch_target_restore "$app" "$backup" "$version")"; then
    [[ -n "$before" ]] || before="$(patch_target_run "$target" patch_target_restart snapshot "$app" "$actions")" || before=""
    if [[ -n "$before" ]] && patch_target_run "$target" patch_target_restart restart "$app" "$actions" "$restored" '{}' "$before"; then
      PATCH_STATUSES[$index]='rolled back: restart or verification failed; previous version restarted'
    else PATCH_STATUSES[$index]='rolled back: previous files restored; restart or verification failed'; fi
  else PATCH_STATUSES[$index]='failed: restart or verification failed; automatic rollback refused or failed'; fi
  return 1
}

patch_show_plan() {
  local undo="${1:-false}" i changes actions
  for ((i=0; i<${#PATCH_TARGETS[@]}; i++)); do
    changes="${PATCH_TARGET_ARTIFACTS[$i]:-$PATCH_ARTIFACTS}/CHANGES"
    log "${PATCH_TARGETS[$i]}: ${PATCH_VERSIONS[$i]}, ${PATCH_APPS[$i]}"
    if [[ ${PATCH_TARGET_CHANGES[$i]+present} ]]; then
      actions=""
      if [[ -n "${PATCH_TARGET_CHANGES[$i]}" || ( "$undo" == true && "${PATCH_VERSIONS[$i]}" == *+patch.* ) ]]; then
        printf '%s\n' "${PATCH_TARGET_CHANGES[$i]}" | sed '/^$/d; s/^/  /'
        actions="$(patch_restart_actions <(printf '%s\n' "${PATCH_TARGET_CHANGES[$i]}"))"
      fi
    else sed 's/^/  /' "$changes"; actions="$(patch_restart_actions "$changes")"; fi
    [[ -n "$actions" ]] || continue
    patch_target_run "${PATCH_TARGETS[$i]}" patch_target_runtime "${PATCH_APPS[$i]}" "$actions" || die "cannot inspect running sessions on ${PATCH_TARGETS[$i]}"
  done
}

cmd_patch() {
  PATCH_TARGETS=(local mac-work); PATCH_TARGET_ARTIFACTS=(); DRY_RUN=false
  local undo=false target answer
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) DRY_RUN=true; shift ;;
      --undo) undo=true; shift ;;
      --targets)
        PATCH_TARGETS=(); shift
        while [[ $# -gt 0 && "$1" != --* ]]; do
          target="$1"; [[ "$target" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$ ]] || die "invalid target: $target"
          [[ " ${PATCH_TARGETS[*]:-} " != *" $target "* ]] || die "duplicate target: $target"
          PATCH_TARGETS+=("$target"); shift
        done ;;
      *) die "patch: unsupported option $1" ;;
    esac
  done
  (( ${#PATCH_TARGETS[@]} > 0 )) || die "patch needs at least one target"
  if [[ " ${PATCH_TARGETS[*]} " == *" local "* ]]; then
    local ordered=(local); for target in "${PATCH_TARGETS[@]}"; do [[ "$target" == local ]] || ordered+=("$target"); done
    PATCH_TARGETS=("${ordered[@]}")
  fi
  patch_collect_targets
  if $undo; then
    patch_prepare_undo
  else
    patch_prepare_source "v$PATCH_RELEASE"
    PATCH_CANDIDATE_REFS="$(patch_candidate_refs)" || die "cannot verify candidate references"
    patch_check_compatibility
    patch_build_diff "$PATCH_RELEASE" "$PATCH_NUMBER"
  fi
  if ! $undo; then patch_plan_targets; fi
  if ! $PATCH_HAS_CHANGES; then
    PATCH_STATUSES=()
    for target in "${PATCH_TARGETS[@]}"; do PATCH_STATUSES+=('already up to date'); log "$target: already up to date"; done
    return 0
  fi
  patch_show_plan "$undo"
  if $DRY_RUN; then log "dry-run: installation unchanged; would replace, restart and verify each target after confirmation"; return 0; fi
  printf 'Apply this patch and restart the listed processes on all targets? [y/N] ' >&2
  if [[ -t 0 && -r /dev/tty ]]; then read -r answer < /dev/tty || answer=""; else read -r answer || answer=""; fi
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes ]] || die "patch was not confirmed"
  patch_deploy_targets
}

cmd_build() {
  parse_common "$@"
  fetch_all
  [[ -n "$TAG" ]] || TAG="$(latest_tag)"
  [[ -n "$TAG" ]] || die "no upstream release tag found"
  local fork branch wt out skipped=()
  fork="$(fork_remote)"; branch="vincent/release-$TAG"; wt="$CH_WORK/worktrees/$TAG"; out="$CH_WORK/artifacts/$TAG"
  mkdir -p "$CH_WORK/worktrees" "$CH_WORK/artifacts"
  if g rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
    log "$branch already exists locally; reusing it (delete the branch to rebuild from scratch)"
    [[ -d "$wt" ]] || g worktree add --quiet "$wt" "$branch"
  else
    [[ ! -e "$wt" ]] || die "$wt exists but $branch does not; remove the stale worktree first"
    # Start from the previous release branch when there is one, so earlier conflict
    # resolutions carry forward; otherwise start fresh from the tag (--fresh forces that).
    local previous=""
    $FRESH || previous="$(previous_release "$TAG")"
    local gw=(git -C "$wt" -c "user.name=$AUTHOR_NAME" -c "user.email=$AUTHOR_EMAIL" -c rerere.enabled=true)
    if [[ -n "$previous" ]]; then
      log "starting from $previous and merging $TAG"
      g worktree add --quiet -b "$branch" "$wt" "$previous"
      seed_rerere "$wt"
      merge_ref "$wt" "$TAG" "Merge upstream $TAG into $branch" ||
        die "conflict merging upstream $TAG onto $previous in $wt — resolve, commit with '-s', then rerun build"
    else
      g worktree add --quiet -b "$branch" "$wt" "$TAG"
    fi
    merge_manifest "$wt" "$SKIP_CONFLICTS"
    # Carry the tooling (this script + manifest) onto the release branch.
    mkdir -p "$wt/scripts" "$wt/vincent"
    [[ "$SCRIPT_PATH" -ef "$wt/scripts/vincent-release.sh" ]] || cp "$SCRIPT_PATH" "$wt/scripts/vincent-release.sh"
    [[ "$MANIFEST" -ef "$wt/vincent/branches.txt" ]] || cp "$MANIFEST" "$wt/vincent/branches.txt"
    git -C "$wt" add scripts/vincent-release.sh vincent/branches.txt
    if ! git -C "$wt" diff --cached --quiet; then
      "${gw[@]}" commit -q -s -m "chore: add vincent release tooling for $TAG"
    fi
  fi
  (
    cd "$wt"
    # Never build an older fork version from a checkout that already contains
    # a newer upstream version (the release filename must match the binaries).
    local source_version
    source_version="$(node -p 'require("./package.json").version')"
    [[ "$source_version" == "${TAG#v}" ]] ||
      die "refusing to build $TAG: source package.json is $source_version; select the matching upstream release"
    install_build_dependencies "$wt"
    rm -rf "$out.tmp"; mkdir -p "$out.tmp/app"
    build_app "$out.tmp/app"
    if ! $NO_TEST; then log "typecheck + tests"; node "$NPM_CLI" run -s typecheck; node "$NPM_CLI" exec -- vitest run --config tests/vitest.config.js; fi
    mkdir -p "$out.tmp/bin"
    node -e 'import("./scripts/release/prepare-npm.mjs").then(({ createNpmBinLauncherSource }) => process.stdout.write(createNpmBinLauncherSource({ version: process.argv[1] })))' "${TAG#v}" > "$out.tmp/bin/codexhost.js"
    chmod +x "$out.tmp/bin/codexhost.js"
    if $RUST; then
      log "cargo build --release (native binaries for $(uname -s)-$(uname -m))"
      cargo build --release --locked --package codexhost-launcher --package codexhost-shim --package codexhost-updater
      mkdir -p "$out.tmp/native-$(uname -s)-$(uname -m)"
      for f in codexhost codexhost-shim codexhost-updater; do cp "target/release/$f" "$out.tmp/native-$(uname -s)-$(uname -m)/"; done
    fi
    {
      echo "tag=$TAG"; echo "branch=$branch"; echo "commit=$(git rev-parse HEAD)"
      echo "built=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "skipped=${skipped[*]:-}"
    } > "$out.tmp/BUILD_INFO"
    (cd "$out.tmp" && find app -type f | LC_ALL=C sort | while read -r f; do sha "$f"; done > SHA256SUMS)
  )
  rm -rf "$out"; mv "$out.tmp" "$out"; echo "$TAG" > "$CH_WORK/last-built-tag"
  log "artifacts: $out"; cat "$out/BUILD_INFO" >&2
}

cmd_push() {
  parse_common "$@"
  [[ -n "$TAG" ]] || TAG="$(cat "$CH_WORK/last-built-tag")"
  local fork; fork="$(fork_remote)"
  log "pushing vincent/release-$TAG to $fork (normal push, never --force)"
  g push "$fork" "vincent/release-$TAG:refs/heads/vincent/release-$TAG"
}

cmd_auto() {
  parse_common "$@"
  fetch_all
  local tag; tag="$(latest_tag)"
  if [[ "$tag" == "$(cat "$CH_WORK/last-built-tag" 2>/dev/null)" ]]; then log "up to date with $tag"; return 0; fi
  log "new upstream release $tag"
  local extra=()
  $SKIP_CONFLICTS && extra+=(--skip-conflicts)
  cmd_build --tag "$tag" "${extra[@]}"
  cmd_push --tag "$tag"
  log "built and pushed $tag; deploy with: $SCRIPT_PATH deploy local|ssh HOST --tag $tag"
}

detect_app_dir() {
  if [[ -n "${CH_APP_DIR:-}" ]]; then echo "$CH_APP_DIR"; return; fi
  local os arch root
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "unsupported OS" ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) die "unsupported arch" ;; esac
  root="$(npm root -g)"
  echo "$root/@codexhost/cli/node_modules/@codexhost/cli-$os-$arch/app"
}

file_ctime() { stat -c %Z "$1" 2>/dev/null || stat -f %c "$1"; }
format_epoch() { date -d "@$1" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || date -r "$1" '+%Y-%m-%d %H:%M:%S %Z'; }

# Prints the running CodexHost processes that started before $1/host-runtime.mjs was written.
# npm pack stamps every mtime with 1985-10-26, so the install time is the file's ctime.
# Only reads the process table; nothing is signalled or restarted.
stale_runtimes() {
  local app="$1" host installed_at version now
  host="$(hostname -s 2>/dev/null || hostname)"
  [[ -f "$app/host-runtime.mjs" ]] || { log "$host: no CodexHost install at $app"; return 0; }
  installed_at="$(file_ctime "$app/host-runtime.mjs")"
  version="$(node -p "require('$app/codexhost-distribution.json').version" 2>/dev/null ||
    node -p "require('$app/../package.json').version" 2>/dev/null || echo unknown)"
  now="$(date +%s)"
  local stale=0 total=0 pid etime title secs started
  # ps etime is [[dd-]hh:]mm:ss on both macOS and Linux procps.
  while read -r pid etime title; do
    case "$title" in
      *"$app/"*|"codexhost remote app-server listener"*|codexhost\ *\ harness\ broker*) ;;
      *) continue ;;
    esac
    secs="$(awk -v t="$etime" 'BEGIN { d = 0; if (index(t, "-")) { split(t, a, "-"); d = a[1]; t = a[2] }
      n = split(t, p, ":"); s = 0; for (i = 1; i <= n; i++) s = s * 60 + p[i]; print d * 86400 + s }')"
    started=$((now - secs))
    total=$((total + 1))
    if (( started < installed_at )); then
      stale=$((stale + 1))
      printf '[vincent-release] %s: installed %s but NOT active: pid %s (%s, started %s) predates the install (%s) - restart needed\n' \
        "$host" "$version" "$pid" "${title:0:90}" "$(format_epoch "$started")" "$(format_epoch "$installed_at")"
    fi
  done < <(ps -axo pid=,etime=,command= 2>/dev/null || ps -eo pid=,etime=,args=)
  if (( total == 0 )); then
    printf '[vincent-release] %s: installed %s; no CodexHost process is running (the next start loads it)\n' "$host" "$version"
  elif (( stale == 0 )); then
    printf '[vincent-release] %s: installed %s is active: all %s running CodexHost processes started after the install\n' "$host" "$version" "$total"
  else
    printf '[vincent-release] %s: %s of %s running CodexHost processes still run the old code - restart them to activate %s\n' "$host" "$stale" "$total" "$version"
  fi
}

cmd_stale() {
  if [[ "${1:-}" == "--ssh" ]]; then
    local host="${2:-}"; [[ -n "$host" ]] || die "stale --ssh USER@HOST"
    # Read-only on the remote side: the script is streamed over stdin, nothing is copied.
    ssh "$host" "bash -lc 'bash -s stale'" < "$SCRIPT_PATH"
    return
  fi
  stale_runtimes "$(detect_app_dir)"
}

cmd_deploy() {
  local mode="${1:-}"; shift || true
  case "$mode" in
    local) deploy_local "$@" ;;
    ssh)
      local host="${1:-}"; shift || die "deploy ssh USER@HOST"
      parse_common "$@"
      [[ -n "$TAG" || -n "$ARTIFACTS" ]] || TAG="$(cat "$CH_WORK/last-built-tag")"
      local src="${ARTIFACTS:-$CH_WORK/artifacts/$TAG}" dst=".codexhost-vincent/incoming/$TAG"
      [[ -f "$src/SHA256SUMS" ]] || die "no artifacts at $src"
      if [[ -f "$src/STATE.json" ]]; then dst=".codexhost-vincent/incoming/patch-$(date +%s)-$$"; fi
      if $DRY_RUN; then log "dry run: would copy $src and deploy on $host"; return 0; fi
      ssh "$host" "mkdir -p '$dst'"
      scp -q -r "$src/." "$host:$dst/"
      scp -q "$SCRIPT_PATH" "$host:.codexhost-vincent/vincent-release.sh"
      local options=""; $ALLOW_MISMATCH && options="--allow-version-mismatch"
      ssh "$host" "bash -lc 'bash ~/.codexhost-vincent/vincent-release.sh deploy local --artifacts ~/$dst $options'"
      ;;
    *) die "deploy local | deploy ssh USER@HOST" ;;
  esac
}

deploy_local() {
  parse_common "$@"
  [[ -n "$TAG" ]] || TAG="$(cat "$CH_WORK/last-built-tag" 2>/dev/null || true)"
  local src="${ARTIFACTS:-$CH_WORK/artifacts/$TAG}" app ts backup run=()
  [[ -f "$src/SHA256SUMS" ]] || die "no artifacts at $src"
  (cd "$src" && sha -c --quiet SHA256SUMS) || die "artifact checksums do not match"
  if [[ -f "$src/STATE.json" ]]; then
    app="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).app' "$src/STATE.json")"
    [[ -w "$app" ]] || read -r -a run <<< "$CH_SUDO"
    if $DRY_RUN; then log "dry run: would apply patch to $app"; return 0; fi
    backup="${CH_BACKUPS:-$HOME/.codexhost-backups}/vincent-patch-$(sed -n 's/^release=//p' "$src/BUILD_INFO")-$(date +%Y%m%d-%H%M%S)-"
    patch_files apply "$src" "$backup"; return
  fi
  TAG="$(sed -n 's/^tag=//p' "$src/BUILD_INFO")"
  app="$(detect_app_dir)"
  [[ -f "$app/host-runtime.mjs" ]] || die "no CodexHost install at $app (set CH_APP_DIR)"
  local installed want
  installed="$(node -p "require('$app/codexhost-distribution.json').version" 2>/dev/null ||
    node -p "require('$app/../package.json').version" 2>/dev/null || echo unknown)"
  want="${TAG#v}"
  # A fork release build (X.Y.Z-vincent.N from the GitHub Release) has the same native
  # launcher/shim as upstream X.Y.Z, so it is a valid base for X.Y.Z artifacts too.
  if [[ "$installed" != "$want" && ! "$installed" =~ ^${want//./\\.}-vincent\.[0-9]+$ ]] && ! $ALLOW_MISMATCH; then
    die "installed CodexHost is $installed but artifacts are for $want. Install the fork release first: 'npm install -g https://github.com/ump45nose/codex-host/releases/latest/download/codexhost-cli.tgz' (or 'npm install -g @codexhost/cli@$want'), or pass --allow-version-mismatch"
  fi
  [[ -w "$app" ]] || read -r -a run <<<"$CH_SUDO"
  ts="$(date +%Y%m%d-%H%M%S)"; backup="$HOME/.codexhost-backups/vincent-$TAG-$ts"
  log "target:  $app (installed $installed)"
  log "backup:  $backup"
  if $DRY_RUN; then log "dry run: would replace ${APP_FILES[*]} plugins/"; return 0; fi
  mkdir -p "$backup"
  for f in "${APP_FILES[@]}"; do cp -p "$app/$f" "$backup/$f"; done
  [[ -d "$app/plugins" ]] && cp -Rp "$app/plugins" "$backup/plugins"
  echo "$app" > "$backup/APP_DIR"
  (cd "$backup" && find . -type f ! -name SHA256SUMS ! -name APP_DIR | LC_ALL=C sort | while read -r f; do sha "$f"; done > SHA256SUMS)
  for f in "${APP_FILES[@]}"; do
    ${run[@]+"${run[@]}"} cp "$src/app/$f" "$app/$f.vincent-new"; ${run[@]+"${run[@]}"} mv -f "$app/$f.vincent-new" "$app/$f"
  done
  ${run[@]+"${run[@]}"} rm -rf "$app/plugins.vincent-new"; ${run[@]+"${run[@]}"} cp -R "$src/app/plugins" "$app/plugins.vincent-new"
  ${run[@]+"${run[@]}"} rm -rf "$app/plugins.vincent-old"
  [[ -d "$app/plugins" ]] && ${run[@]+"${run[@]}"} mv "$app/plugins" "$app/plugins.vincent-old"
  ${run[@]+"${run[@]}"} mv "$app/plugins.vincent-new" "$app/plugins"; ${run[@]+"${run[@]}"} rm -rf "$app/plugins.vincent-old"
  local native
  native="$src/native-$(uname -s)-$(uname -m)"
  if [[ -d "$native" ]]; then
    local pkg; pkg="$(dirname "$app")"
    mkdir -p "$backup/native"
    for f in bin/codexhost libexec/codexhost-shim libexec/codexhost-updater; do
      [[ -f "$pkg/$f" ]] || continue
      cp -p "$pkg/$f" "$backup/native/$(basename "$f")"
      ${run[@]+"${run[@]}"} cp "$native/$(basename "$f")" "$pkg/$f.vincent-new"; ${run[@]+"${run[@]}"} mv -f "$pkg/$f.vincent-new" "$pkg/$f"
    done
  fi
  if [[ -f "$src/bin/codexhost.js" ]]; then
    local meta_bin
    meta_bin="${app%/node_modules/@codexhost/cli-*}/bin/codexhost.js"
    if [[ -f "$meta_bin" ]]; then
      mkdir -p "$backup/meta-bin"
      cp -p "$meta_bin" "$backup/meta-bin/codexhost.js"
      sed "s/^const version = \".*\";$/const version = \"$installed\";/" "$src/bin/codexhost.js" > "$meta_bin.vincent-new"
      chmod +x "$meta_bin.vincent-new"
      ${run[@]+"${run[@]}"} mv -f "$meta_bin.vincent-new" "$meta_bin"
    fi
  fi
  (cd "$src" && for f in "${APP_FILES[@]}"; do
     [[ "$(sha "app/$f" | cut -d' ' -f1)" == "$(sha "$app/$f" | cut -d' ' -f1)" ]] || die "verify failed for $f"
   done)
  cp "$src/BUILD_INFO" "$HOME/.codexhost-backups/vincent-current" 2>/dev/null || true
  log "deployed $TAG ($(sed -n 's/^commit=//p' "$src/BUILD_INFO" | cut -c1-12)) into $app"
  cat >&2 <<NOTICE

  *** Nothing was restarted. ***
  The running CodexHost / Codex Desktop still uses the old code. Restart them yourself
  when convenient (quit Codex Desktop and relaunch it through codexhost; on a Remote SSH
  host, the next remote session start picks up the new host-runtime).
  Roll back with: $SCRIPT_PATH rollback $backup

NOTICE
  stale_runtimes "$app" >&2
}

cmd_rollback() {
  local backup="${1:-}" candidate
  if [[ -z "$backup" ]]; then
    for candidate in "${CH_BACKUPS:-$HOME/.codexhost-backups}"/vincent-*; do
      [[ -f "$candidate/APP_DIR" && ( -z "$backup" || "$candidate" -nt "$backup" ) ]] && backup="$candidate"
    done
  fi
  [[ -f "$backup/APP_DIR" ]] || die "no usable backup (looked at '$backup')"
  local app run=(); app="$(cat "$backup/APP_DIR")"; [[ -w "$app" ]] || read -r -a run <<<"$CH_SUDO"
  (cd "$backup" && sha -c --quiet SHA256SUMS) || die "backup checksums do not match"
  if [[ -f "$backup/PATCH_BACKUP.json" ]]; then
    patch_files restore "$backup" || return 1
    log "restored $app from $backup (nothing restarted)"; return 0
  fi
  for f in "${APP_FILES[@]}"; do ${run[@]+"${run[@]}"} cp -p "$backup/$f" "$app/$f"; done
  if [[ -d "$backup/plugins" ]]; then ${run[@]+"${run[@]}"} rm -rf "$app/plugins"; ${run[@]+"${run[@]}"} cp -Rp "$backup/plugins" "$app/plugins"; fi
  log "restored $app from $backup (nothing restarted)"
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    status) cmd_status "$@" ;;
    audit) cmd_audit "$@" ;;
    build) cmd_build "$@" ;;
    push) cmd_push "$@" ;;
    auto) cmd_auto "$@" ;;
    deploy) cmd_deploy "$@" ;;
    rollback) cmd_rollback "$@" ;;
    stale) cmd_stale "$@" ;;
    patch) cmd_patch "$@" ;;
    __patch_target) "$@" ;;
    ""|-h|--help|help) sed -n '2,27p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//' ;;
    *) die "unknown command $cmd (see --help)" ;;
  esac
}
if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]:-}" == "$0" ]]; then main "$@"; fi
