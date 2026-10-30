#!/usr/bin/env bash
# The release screenshot review (#11216): builds a release, runs it on a private server with made-up data, photographs every page at 1440, 900 and 390 px, compares with the previous release's shots and
# files everything on a "UI review: vX.Y.Z" task as Coral artifacts. A plain script from start to finish: no agent, no model, no tokens.
#
#   tests/release/screens/run.sh <version> [--ref REF] [--themes dark,light] [--prev VERSION] [--no-publish] [--dry-run] [--keep]
#
#   <version>    the release, e.g. v2.0.7. Its tag is built; with no such tag (a candidate) the current commit is, or --ref (a branch or a commit)
#   --themes     dark (the default), light, or both
#   --no-publish take the shots and compare them, upload nothing (the shots stay in the cache and in --out)
#   --dry-run    build the contact sheet and the task text but call no coral-board or coral-agent
#   --keep       keep the private data folder and the shots' work folder (for a failed run)
# Needs Go, Node 20+, git, Chrome (or SCREENS_CHROME=/path/to/chrome, or "npx playwright install chromium" and SCREENS_CHANNEL=chromium), and for the upload a coral-board and coral-agent that are
# signed in as the person who runs it (SCREENS_BIN=<dir> to name the folder of those two programs).
# NEVER ~/.coral and never :8420: the server gets its own data folder and a free port, --cloud-url off and --no-browser. The shots of each release are kept by version in
# ${SCREENS_CACHE:-~/.cache/coral-screens}/<version>/, which the next release is compared with.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
# The runner's own identity (a session, a token, the board it is on) is what files the shots at the end; the private servers and everything else must never see it, so it is set aside here, before
# agent_env.sh clears it, and handed to publish.mjs alone.
KEEP_ENV=()
for v in CORAL_SESSION_NAME CORAL_SESSION_ID CORAL_SESSION_TOKEN CORAL_SESSION_AUTH_FILE CORAL_SUBSCRIBER_ID CORAL_URL CORAL_PORT CORAL_HOST CORAL_DATA_DIR CORAL_DIR TMUX TMUX_PANE \
         CORAL_TMUX_SOCKET CORAL_TMUX_FALLBACK CORAL_BOARD_HELPER CORAL_BOARD_ARGS CORAL_AGENT_HELPER CORAL_AGENT_ARGS CORAL_CLOUD_URL CORAL_HUB CORAL_SHELL; do
    [ -n "${!v:-}" ] && KEEP_ENV+=("$v=${!v}")
done
source "$ROOT/tests/lib/agent_env.sh"   # clears an agent shell's identity and production links
source "$ROOT/tests/lib/backend.sh"

VERSION="" REF="" THEMES="dark" PREV="" PUBLISH=1 DRY=0 KEEP=0
while [ $# -gt 0 ]; do
    case "$1" in
        --ref) REF="$2"; shift 2 ;;
        --themes) THEMES="$2"; shift 2 ;;
        --prev) PREV="$2"; shift 2 ;;
        --no-publish) PUBLISH=0; shift ;;
        --dry-run) DRY=1; shift ;;
        --keep) KEEP=1; shift ;;
        -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
        -*) echo "unknown option $1" >&2; exit 2 ;;
        *) VERSION="$1"; shift ;;
    esac
done
[ -n "$VERSION" ] || { echo "usage: run.sh <version> [options]  (see the top of this file)" >&2; exit 2; }
VER="${VERSION#v}"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] || { echo "not a release version: $VERSION" >&2; exit 2; }
CACHE="${SCREENS_CACHE:-$HOME/.cache/coral-screens}"
case "$CACHE" in "$HOME/.coral"|"$HOME/.coral/"*) echo "refusing a cache inside ~/.coral" >&2; exit 2 ;; esac

log() { echo "[screens] $*"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/coral-screens.XXXXXX")"
SEEDED_PID="" FRESH_PID="" TREE="" TREE_IS_WORKTREE=0
stop_server() { # kills only the process this run started, and only its own tmux server
    local pid="$1" data="$2"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
    if [ -n "$data" ] && [ -S "$data/tmux.sock" ]; then tmux -S "$data/tmux.sock" kill-server 2>/dev/null || true; fi
}
cleanup() {
    local rc=$?
    trap - EXIT
    stop_server "$SEEDED_PID" "$WORK/seeded/data"
    stop_server "$FRESH_PID" "$WORK/fresh/data"
    coral_test_sandbox_cleanup 2>/dev/null || true
    if [ "$TREE_IS_WORKTREE" = 1 ] && [ -n "$TREE" ]; then git -C "$ROOT" worktree remove --force "$TREE" 2>/dev/null || true; fi
    if [ "$KEEP" = 1 ] || [ "$rc" != 0 ]; then log "kept $WORK (--keep or a failed run)"; else rm -rf "$WORK"; fi   # the data of the private server goes with it
    exit "$rc"
}
trap cleanup EXIT

# ── the tree to build: the release's tag, else --ref, else the current commit; always in a worktree of its own, so this checkout is never touched ──
if [ -n "$REF" ]; then BUILD_REF="$REF"
elif git -C "$ROOT" rev-parse --verify --quiet "refs/tags/v$VER^{commit}" >/dev/null; then BUILD_REF="v$VER"
else BUILD_REF="HEAD"; log "no tag v$VER and no --ref: building the current commit"; fi
TREE="$WORK/tree"
git -C "$ROOT" worktree add --detach "$TREE" "$BUILD_REF" >/dev/null 2>&1 || { echo "cannot check out $BUILD_REF" >&2; exit 1; }
TREE_IS_WORKTREE=1
SHA="$(git -C "$TREE" rev-parse HEAD)"
log "version v$VER, build $SHA ($BUILD_REF)"

# ── dependencies of the script itself (pinned in package-lock.json) ──────────────────────────────
if [ ! -d "$HERE/node_modules/playwright" ]; then log "installing the screenshot script's packages"; (cd "$HERE" && npm ci --no-audit --no-fund >/dev/null); fi

# ── build ────────────────────────────────────────────────────────────────────────────────────────
BIN="$WORK/bin"; mkdir -p "$BIN"
log "building the dev server, the board tools and the mock agent"
(
    cd "$TREE/coral-go"
    ../tools/sync-agent-docs.sh >/dev/null   # the docs the Docs page reads are copied into the embed before a build (the Makefile does this too)
    go build -p 2 -tags "dev fts5" -o "$BIN/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent ./cmd/coral-hook-agentic-state ./cmd/coral-hook-session-start ./cmd/coral-hook-message-check ./cmd/coral-hook-task-sync
    go build -o "$BIN/mock-agent" ./cmd/mock-agent
)

# ── two private servers: one with data, one with nothing (the first-run screens) ─────────────────
coral_test_sandbox   # an isolated HOME and a stub for every agent CLI first on PATH: a real CLI can never run
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
start_server() { # name, extra env...
    local name="$1"; shift
    local dir="$WORK/$name"; mkdir -p "$dir/data" "$dir/env-dump" "$dir/work"
    local port; port="$(free_port)"
    [ "$port" != 8420 ] || { echo "refusing :8420" >&2; exit 2; }
    env -u CORAL_PORT -u CORAL_URL -u CORAL_DATA_DIR -u CORAL_DIR -u CLAUDE_PROJECTS_DIR -u GEMINI_TMP_DIR -u ANTIGRAVITY_DATA_DIR -u PI_CODING_AGENT_DIR \
        HOME="$CORAL_TEST_HOME" USERPROFILE="$CORAL_TEST_HOME" CODEX_HOME="$CORAL_TEST_HOME/.codex" PATH="$CORAL_TEST_STUB_BIN:$PATH" \
        CORAL_TELEMETRY_DISABLED=1 CORAL_NO_DEMO_SEED=1 CORAL_TMUX_NO_FALLBACK=1 CORAL_HOOK_DIR="$BIN" MOCK_AGENT_ENV_DUMP="$dir/env-dump" MOCK_AGENT_READY=1 \
        CLAUDE_PROJECTS_DIR="$CORAL_TEST_HOME/.claude/projects" "$@" \
        "$BIN/coral" --home "$dir/data" --no-browser --cloud-url off --host 127.0.0.1 --port "$port" --backend "${CORAL_TEST_BACKEND:-tmux}" >"$dir/server.log" 2>&1 &
    echo "$! $port"
}
read -r SEEDED_PID SEEDED_PORT < <(umask 077; mkdir -p "$WORK/seeded"; printf 'screens-run-password\n' > "$WORK/seeded/initial-password"; start_server seeded CORAL_NO_WELCOME=1 CORAL_INITIAL_PASSWORD_FILE="$WORK/seeded/initial-password")
read -r FRESH_PID FRESH_PORT < <(start_server fresh)
SEEDED="http://127.0.0.1:$SEEDED_PORT"; FRESH="http://127.0.0.1:$FRESH_PORT"
for u in "$SEEDED" "$FRESH"; do command curl -sS --retry 12 --retry-connrefused --retry-max-time 60 --max-time 3 -o /dev/null "$u/api/health" || { echo "server at $u did not start" >&2; exit 1; }; done
link_for() { "$BIN/coral" open --print --url "$1" --home "$2" | sed -n 's/^ *\(http[^ ]*login_token=[^ ]*\).*/\1/p' | head -1; }
log "seeding $SEEDED"
node "$HERE/seed.mjs" --base "$SEEDED" --link "$(link_for "$SEEDED" "$WORK/seeded/data")" --bin "$BIN" --env-dump "$WORK/seeded/env-dump" --work "$WORK/seeded/work" \
    --home "$CORAL_TEST_HOME" --data "$WORK/seeded/data" --out "$WORK/seed.json"

# ── the shots ────────────────────────────────────────────────────────────────────────────────────
OUT="${SCREENS_OUT:-$WORK/out}"; mkdir -p "$OUT"
log "photographing (themes: $THEMES) into $OUT"
node "$HERE/shoot.mjs" --out "$OUT" --seed "$WORK/seed.json" --themes "$THEMES" \
    --seeded "$SEEDED" --seeded-link "$(link_for "$SEEDED" "$WORK/seeded/data")" --fresh "$FRESH" --fresh-link "$(link_for "$FRESH" "$WORK/fresh/data")"
# A stub that was run for anything but a "--version" probe (Settings and the CLI checks probe every agent CLI) means a launch fell back to a CLI on PATH.
if [ -s "${CORAL_TEST_STUB_MARKER:-/nonexistent}" ] && grep -v -- ' --version$' "$CORAL_TEST_STUB_MARKER" | grep -q .; then log "WARNING: an agent CLI on PATH was run for more than a version probe:"; grep -v -- ' --version$' "$CORAL_TEST_STUB_MARKER" | head -3; fi
stop_server "$SEEDED_PID" "$WORK/seeded/data"; SEEDED_PID=""
stop_server "$FRESH_PID" "$WORK/fresh/data"; FRESH_PID=""
rm -rf "$WORK/seeded/data" "$WORK/fresh/data"    # the private data is gone before anything is filed
node -e "const f='$OUT/results.json',r=JSON.parse(require('fs').readFileSync(f));r.ranAt=new Date().toISOString();require('fs').writeFileSync(f,JSON.stringify(r,null,2))"

# ── compare with the previous release ────────────────────────────────────────────────────────────
mkdir -p "$CACHE"
if [ -z "$PREV" ]; then
    PREV="$( { ls -1 "$CACHE" 2>/dev/null || true; } | { grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+' | sed 's/^v//' | grep -vx "$VER" | sort -t. -k1,1n -k2,2n -k3,3n | while read -r v; do
        # only versions before this one
        [ "$(printf '%s\n%s\n' "$v" "$VER" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$v" ] && echo "$v"; done | tail -1; } || true)"
fi
PREV_DIR=""; [ -n "$PREV" ] && [ -d "$CACHE/${PREV#v}" ] && PREV_DIR="$CACHE/${PREV#v}"
log "compared with: ${PREV_DIR:-nothing (this run is the baseline)}"
node "$HERE/diff.mjs" ${PREV_DIR:+--prev "$PREV_DIR"} --cur "$OUT" --out "$OUT"

# ── keep these shots for the next release (the cache is outside the repo), then file them ────────
rm -rf "$CACHE/$VER.tmp"; mkdir -p "$CACHE/$VER.tmp"
cp -R "$OUT"/dark "$OUT"/light "$OUT"/results.json "$CACHE/$VER.tmp/" 2>/dev/null || true
rm -rf "$CACHE/$VER"; mv "$CACHE/$VER.tmp" "$CACHE/$VER"
log "kept in $CACHE/$VER"
if [ "$PUBLISH" = 1 ] || [ "$DRY" = 1 ]; then
    set +e
    env ${KEEP_ENV[@]+"${KEEP_ENV[@]}"} node "$HERE/publish.mjs" --out "$OUT" --version "$VER" --sha "$SHA" ${PREV_DIR:+--prev "$PREV_DIR"} $([ "$DRY" = 1 ] && echo --dry-run)
    rc=$?
    set -e
    cp "$OUT/links.json" "$CACHE/$VER/" 2>/dev/null || true   # the links of this release's artifacts: the next release's unchanged shots link to them
    [ "$rc" = 0 ] || { log "WARNING: filing the shots failed (see above); the shots are in $OUT and $CACHE/$VER. This never blocks a release."; [ -n "${SCREENS_STRICT:-}" ] && exit "$rc"; }
fi
[ "$PUBLISH" = 1 ] || log "shots in $OUT"
log "done"
