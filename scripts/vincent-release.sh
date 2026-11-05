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
# Nothing here restarts CodexHost or Codex Desktop; deploy prints a notice instead.
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
TOOLS_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
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

cmd_status() {
  fetch_all
  local tag fork; tag="$(latest_tag)"; fork="$(fork_remote)"
  echo "latest upstream tag: $tag"
  echo "last built tag:      $(cat "$CH_WORK/last-built-tag" 2>/dev/null || echo none)"
  for b in $(manifest_branches); do
    local ref="$fork/$b" state
    if ! g rev-parse -q --verify "$ref^{commit}" >/dev/null; then state="MISSING on fork"
    elif g merge-base --is-ancestor "$ref" "$tag"; then state="already in $tag (drop from manifest)"
    else state="$(g rev-list --count "$tag..$ref") commits to merge, $(g rev-list --count "$ref..$tag") behind"; fi
    printf '  %-46s %s\n' "$b" "$state"
  done
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
      "${gw[@]}" merge --no-ff --no-edit -q -m "Merge upstream $TAG into $branch" "$TAG" ||
        die "conflict merging upstream $TAG onto $previous in $wt — resolve, commit with '-s', then rerun build"
    else
      g worktree add --quiet -b "$branch" "$wt" "$TAG"
    fi
    for b in $(manifest_branches); do
      local ref="$fork/$b"
      if ! git -C "$wt" rev-parse -q --verify "$ref^{commit}" >/dev/null; then log "skip $b: not on fork"; skipped+=("$b(missing)"); continue; fi
      if git -C "$wt" merge-base --is-ancestor "$ref" HEAD; then log "skip $b: already contained"; continue; fi
      log "merging $b"
      if ! "${gw[@]}" merge --no-ff --no-edit -q "$ref"; then
        if $SKIP_CONFLICTS; then
          git -C "$wt" diff --name-only --diff-filter=U | sed 's/^/    conflict: /' >&2
          git -C "$wt" merge --abort; skipped+=("$b(conflict)"); log "skipped $b because of conflicts"; continue
        fi
        die "conflict merging $b in $wt — resolve, commit with '-s', then rerun build (the branch is reused)"
      fi
    done
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
    log "npm ci"; npm ci --no-audit --no-fund >/dev/null
    log "build"; npm run -s build:typescript; npm run -s build:renderer
    if ! $NO_TEST; then log "typecheck + tests"; npm run -s typecheck; npx vitest run --config tests/vitest.config.js; fi
    rm -rf "$out.tmp"; mkdir -p "$out.tmp/app"
    node packages/host-runtime/scripts/build-release.mjs --output "$out.tmp/app/host-runtime.mjs"
    node packages/desktop-control/scripts/build-release.mjs --output "$out.tmp/app/desktop-controller.mjs"
    node packages/console-server/scripts/build-release.mjs --output "$out.tmp/app/console-server.mjs"
    cp packages/renderer-extension/dist/production.js "$out.tmp/app/renderer-extension.js"
    cp packages/renderer-extension/dist/console.js "$out.tmp/app/console-web.js"
    node scripts/release/harness-plugins.mjs --output "$out.tmp/app/plugins"
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

cmd_deploy() {
  local mode="${1:-}"; shift || true
  case "$mode" in
    local) deploy_local "$@" ;;
    ssh)
      local host="${1:-}"; shift || die "deploy ssh USER@HOST"
      local forwarded=("$@")
      parse_common "$@"
      [[ -n "$TAG" ]] || TAG="$(cat "$CH_WORK/last-built-tag")"
      local src="${ARTIFACTS:-$CH_WORK/artifacts/$TAG}" dst=".codexhost-vincent/incoming/$TAG"
      [[ -f "$src/SHA256SUMS" ]] || die "no artifacts at $src"
      ssh "$host" "mkdir -p '$dst'"
      scp -q -r "$src/." "$host:$dst/"
      scp -q "$SCRIPT_PATH" "$host:.codexhost-vincent/vincent-release.sh"
      ssh -t "$host" "bash -lc 'bash ~/.codexhost-vincent/vincent-release.sh deploy local --artifacts ~/$dst ${forwarded[*]}'"
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
}

cmd_rollback() {
  local backup="${1:-}" candidate
  if [[ -z "$backup" ]]; then
    for candidate in "$HOME"/.codexhost-backups/vincent-v*; do
      [[ -f "$candidate/APP_DIR" && ( -z "$backup" || "$candidate" -nt "$backup" ) ]] && backup="$candidate"
    done
  fi
  [[ -f "$backup/APP_DIR" ]] || die "no usable backup (looked at '$backup')"
  local app run=(); app="$(cat "$backup/APP_DIR")"; [[ -w "$app" ]] || read -r -a run <<<"$CH_SUDO"
  (cd "$backup" && sha -c --quiet SHA256SUMS) || die "backup checksums do not match"
  for f in "${APP_FILES[@]}"; do ${run[@]+"${run[@]}"} cp -p "$backup/$f" "$app/$f"; done
  if [[ -d "$backup/plugins" ]]; then ${run[@]+"${run[@]}"} rm -rf "$app/plugins"; ${run[@]+"${run[@]}"} cp -Rp "$backup/plugins" "$app/plugins"; fi
  log "restored $app from $backup (nothing restarted)"
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    status) cmd_status "$@" ;;
    build) cmd_build "$@" ;;
    push) cmd_push "$@" ;;
    auto) cmd_auto "$@" ;;
    deploy) cmd_deploy "$@" ;;
    rollback) cmd_rollback "$@" ;;
    ""|-h|--help|help) sed -n '2,25p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//' ;;
    *) die "unknown command $cmd (see --help)" ;;
  esac
}
main "$@"
