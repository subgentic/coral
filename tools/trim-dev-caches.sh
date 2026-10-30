#!/usr/bin/env bash
# tools/trim-dev-caches.sh: keeps a development Mac from filling up with Go build cache and stale worktrees (#11251; the build cache reached 164 GB
# on 2026-10-30: many worktrees times many go test runs outgrow Go's own trim, which drops only entries unused for 5 days).
#
#   tools/trim-dev-caches.sh [--hours N] [--apply] [--worktree-root DIR] [--dry-run]
#
# 1. Go build cache: deletes the files of GOCACHE (go env GOCACHE; ~/Library/Caches/go-build on a Mac) not used in the last N hours (default 6). Go sets an entry's
#    mtime when it uses it, so a build in flight is not affected. It never runs `go clean -cache`. --dry-run only reports.
# 2. Worktrees under DIR (default ~/Software; the main checkout is never touched): LISTS each one whose HEAD is merged into origin/main, that has had no file
#    changed for 2 days and that no process is working in (no process has it as its working directory). Only --apply removes them, with `git worktree remove`
#    (no --force: git itself refuses a worktree with uncommitted changes, and this script skips one that shows any change or any untracked file). The branch is left alone.
# 3. The CDP runner's temp folders (coral-cdp-*, under TMPDIR): reported; with --apply the ones untouched for 24 h are removed.
# Reports the sizes before and after; the log line goes to LOG (default ~/.cache/coral-dev-trim.log), never ~/.coral. The Go module cache is only reported.
#
# Hourly on a Mac: tools/dev.coral.trim-dev-caches.plist (copy to ~/Library/LaunchAgents, replace __REPO__, `launchctl load`). The hourly job runs
# the cache trim and lists the worktrees; removing worktrees is a person's decision (--apply).
set -uo pipefail

HOURS=6; APPLY=false; DRY=false
ROOT="${WORKTREE_ROOT:-$HOME/Software}"
LOG="${TRIM_LOG:-$HOME/.cache/coral-dev-trim.log}"
while [ $# -gt 0 ]; do
  case "$1" in
    --hours) HOURS="${2:?--hours needs a number}"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    --dry-run) DRY=true; shift ;;
    --worktree-root) ROOT="${2:?}"; shift 2 ;;
    -h|--help) sed -n 2,19p "$0"; exit 0 ;;
    *) echo "trim-dev-caches: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$HOURS" in ''|*[!0-9]*) echo "trim-dev-caches: --hours is a whole number" >&2; exit 2 ;; esac
[ "$HOURS" -ge 1 ] || { echo "trim-dev-caches: --hours is at least 1" >&2; exit 2; }

size() { [ -e "$1" ] && du -sk "$1" 2>/dev/null | awk '{printf "%.1f GB", $1/1048576}' || echo "0 GB"; }
say() { echo "$*"; mkdir -p "$(dirname "$LOG")" && echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

GOCACHE_DIR="${TRIM_GOCACHE:-$(go env GOCACHE 2>/dev/null)}"; [ -n "$GOCACHE_DIR" ] || GOCACHE_DIR="$HOME/Library/Caches/go-build"  # TRIM_GOCACHE: the tests
MODCACHE="$(go env GOMODCACHE 2>/dev/null)"

# 1. the build cache
before="$(size "$GOCACHE_DIR")"
if [ -d "$GOCACHE_DIR" ]; then
  n=$(find "$GOCACHE_DIR" -type f -mmin +$((HOURS * 60)) 2>/dev/null | wc -l | tr -d ' ')
  if $DRY; then say "go-build: $before at $GOCACHE_DIR; $n files unused for ${HOURS}h would be deleted (dry run)"
  else
    find "$GOCACHE_DIR" -type f -mmin +$((HOURS * 60)) -delete 2>/dev/null
    say "go-build: $before -> $(size "$GOCACHE_DIR") ($n files unused for ${HOURS}h deleted) at $GOCACHE_DIR"
  fi
else say "go-build: no cache at $GOCACHE_DIR"; fi
[ -n "$MODCACHE" ] && say "go mod cache: $(size "$MODCACHE") (not trimmed)"

# 3. the CDP runner's temp folders
T="${TMPDIR:-/tmp}"
cdp=$(find "$T" -maxdepth 1 -name 'coral-cdp-*' 2>/dev/null | wc -l | tr -d ' ')
old=$(find "$T" -maxdepth 1 -name 'coral-cdp-*' -mmin +1440 2>/dev/null)
say "cdp temp folders under $T: $cdp ($(echo "$old" | grep -c .) untouched for 24 h)"
if $APPLY && [ -n "$old" ]; then echo "$old" | while IFS= read -r d; do rm -rf -- "$d"; done; say "cdp temp folders: removed $(echo "$old" | grep -c .)"; fi

# 2. the worktrees
[ -d "$ROOT" ] || { say "worktrees: no folder $ROOT"; exit 0; }
MAIN="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$MAIN" ] || { say "worktrees: run from a checkout of coral"; exit 0; }
git -C "$MAIN" fetch -q origin main 2>/dev/null || say "worktrees: could not fetch origin/main; using the local ref"
git -C "$MAIN" rev-parse -q --verify origin/main >/dev/null || { say "worktrees: no origin/main"; exit 0; }
# every process's working directory, one lsof call
CWDS="$(lsof -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
ROOT="$(cd "$ROOT" && pwd -P)"
listed=0; removed=0; skipped=0
while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  case "$wt" in "$ROOT"/*) ;; *) continue ;; esac
  [ "$wt" = "$MAIN" ] && continue
  [ -d "$wt" ] || continue
  head=$(git -C "$wt" rev-parse -q --verify HEAD 2>/dev/null) || continue
  git -C "$MAIN" merge-base --is-ancestor "$head" origin/main 2>/dev/null || { skipped=$((skipped+1)); continue; }
  if [ -n "$(find "$wt" \( -name .git -o -name node_modules \) -prune -o -mtime -2 -print -quit 2>/dev/null)" ]; then skipped=$((skipped+1)); continue; fi
  if echo "$CWDS" | grep -qE "^$(printf '%s' "$wt" | sed 's/[.[\*^$()+?{|]/\\&/g')(/|$)"; then skipped=$((skipped+1)); continue; fi
  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then skipped=$((skipped+1)); continue; fi
  listed=$((listed+1))
  if $APPLY; then
    if git -C "$MAIN" worktree remove "$wt" 2>/dev/null; then removed=$((removed+1)); echo "removed $wt"; else echo "git refused $wt"; fi
  else echo "would remove $wt ($(size "$wt"))"; fi
done < <(git -C "$MAIN" worktree list --porcelain | sed -n 's/^worktree //p')
$APPLY && git -C "$MAIN" worktree prune
say "worktrees under $ROOT: $listed merged and idle ($([ $APPLY = true ] && echo "$removed removed" || echo "listed only; --apply removes")), $skipped kept (not merged, changed in 2 days, in use or dirty)"
