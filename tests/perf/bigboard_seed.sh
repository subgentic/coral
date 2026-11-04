#!/usr/bin/env bash
# bigboard_seed.sh (#13154, goal #215): the seeded big-board fixture the performance sprint measures against.
#
#   PERF_RUN=1 FIXTURE=/some/empty/folder bash tests/perf/bigboard_seed.sh          the full fixture
#   PERF_RUN=1 SMALL=1 FIXTURE=... bash tests/perf/bigboard_seed.sh                  a smoke-sized one (about 1 minute)
#
# Resumable: a stopped or failed run is continued by running the same command again on the same FIXTURE (state is in FIXTURE/.seed: stage markers, the
# agents' token files and an upload ledger). Done stages are skipped; uploads carry on from each file's last recorded version. A run cut inside the
# messages-and-tasks stage (about 3 minutes) starts that stage again on a fresh data folder, so nothing is posted twice. If the agents' tokens do not
# survive the stop (the seed server is restarted), 30 new agents are launched once and the uploads go on with them (fixture.json says so).
#
# Makes, in FIXTURE: data/ (a Coral data folder), repo/ (the git repo agents work in), bin/ (the tools built from REPO),
# fixture.json (what is in it). Full size: 20,000 artifact uploads (200 files x 100 versions, all tagged "for review", by the
# agents' own tokens), 30 mock agents, 2,000 tasks, 50,000 board messages, a 35,000-change git repo. A heavy run: announce
# it (HEAVY RUN START/END) and run one at a time. Safe on a Mac: its own data folder and port (never ~/.coral or :8420),
# --cloud-url off, --no-browser, the mock-agent sandbox (tests/lib/mock_sandbox.sh: an isolated HOME, stub CLIs, a private tmux
# socket), telemetry off. It kills only the PIDs it started.
#
# The real server refuses more than 100 uploads per agent per hour, so the SEED server (only) is built with that window
# raised through `go build -overlay` (a patched copy of routes/artifact_store.go in the work folder; nothing in REPO changes).
# Whatever measures the fixture runs the plain build in FIXTURE/bin on a copy of FIXTURE/data.
#
# Env: PERF_RUN=1 (required), FIXTURE (required, empty or new), REPO (default: this checkout), SMALL=1, PORT (8741), GO,
#      FILES (200) VERSIONS (100) AGENTS (30) TASKS (2000) MSGS (50000) CHANGES (35000) UPLOAD_WORKERS (8).
set -uo pipefail
export CORAL_TELEMETRY_DISABLED=1
if [[ "${PERF_RUN:-}" != "1" ]]; then echo "[bigboard] opt-in: set PERF_RUN=1" >&2; exit 2; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$HERE/../.." && pwd)}"
GO="${GO:-$(command -v go || echo "$HOME/.local/go/bin/go")}"
PORT="${PORT:-8741}"
[[ -n "${FIXTURE:-}" ]] || { echo "[bigboard] set FIXTURE to an empty or new folder" >&2; exit 2; }
[[ "$PORT" != 8420 ]] || { echo "[bigboard] refusing :8420" >&2; exit 2; }
if [[ -n "${SMALL:-}" ]]; then FILES="${FILES:-6}"; VERSIONS="${VERSIONS:-5}"; AGENTS="${AGENTS:-3}"; TASKS="${TASKS:-40}"; MSGS="${MSGS:-300}"; CHANGES="${CHANGES:-1500}"
else FILES="${FILES:-200}"; VERSIONS="${VERSIONS:-100}"; AGENTS="${AGENTS:-30}"; TASKS="${TASKS:-2000}"; MSGS="${MSGS:-50000}"; CHANGES="${CHANGES:-35000}"; fi
mkdir -p "$FIXTURE" || exit 1
FIXTURE="$(cd "$FIXTURE" && pwd)"
ST="$FIXTURE/.seed"
if [[ -n "$(ls -A "$FIXTURE")" && ! -d "$ST" ]]; then echo "[bigboard] FIXTURE is not empty and not a fixture of this script: $FIXTURE" >&2; exit 2; fi
[[ ! -f "$ST/complete" ]] || { echo "[bigboard] this fixture is already complete: $FIXTURE"; exit 0; }
mkdir -p "$ST/env"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "[bigboard] port $PORT is in use" >&2; exit 2; fi

source "$HERE/../lib/mock_sandbox.sh"
log() { echo "[bigboard] $*"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bigboard.XXXXXX")" || exit 1
SRV=""; UP=""
cleanup() {
  [[ -n "$UP" ]] && kill -0 "$UP" 2>/dev/null && kill "$UP" 2>/dev/null
  [[ -n "$SRV" ]] && kill -0 "$SRV" 2>/dev/null && { kill "$SRV" 2>/dev/null; for _ in $(seq 120); do kill -0 "$SRV" 2>/dev/null || break; sleep 0.5; done; kill -9 "$SRV" 2>/dev/null; }
  [[ -S "$FIXTURE/data/tmux.sock" ]] && tmux -S "$FIXTURE/data/tmux.sock" kill-server 2>/dev/null
  sleep 2
  rm -rf -- "$WORK"
  coral_test_sandbox_cleanup
}
trap cleanup EXIT
trap 'exit 143' TERM INT

# 1. the tools (plain) and the seed server (upload window raised, by overlay)
log "building the tools from $REPO"
mkdir -p "$FIXTURE/bin" "$WORK/seedbin"
( cd "$REPO/coral-go" && "$GO" build -p 2 -tags "dev fts5" -o "$FIXTURE/bin/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent \
    ./cmd/coral-hook-agentic-state ./cmd/coral-hook-session-start ./cmd/coral-hook-message-check ./cmd/coral-hook-task-sync ./cmd/mock-agent ) || exit 1
STORE="$REPO/coral-go/internal/server/routes/artifact_store.go"
sed -E 's/(uploadWindowCount[[:space:]]+= )[0-9]+/\110000000/; s/(uploadWindowBytes[[:space:]]+= )[0-9]+ << [0-9]+/\11 << 50/' "$STORE" > "$WORK/artifact_store.go"
grep -q '10000000' "$WORK/artifact_store.go" && grep -q '1 << 50' "$WORK/artifact_store.go" || { log "could not raise the upload window in the copy (artifact_store.go changed?)"; exit 1; }
printf '{"Replace":{"%s":"%s"}}\n' "$STORE" "$WORK/artifact_store.go" > "$WORK/overlay.json"
( cd "$REPO/coral-go" && "$GO" build -p 2 -overlay "$WORK/overlay.json" -tags "dev fts5" -o "$WORK/seedbin/coral" ./cmd/coral ) || exit 1
[[ -f "$FIXTURE/commit.txt" ]] || { git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown; } > "$FIXTURE/commit.txt"

# 2. the repo
if [[ -f "$ST/repo.done" ]]; then log "repo: done already"; else
  rm -rf -- "$FIXTURE/repo"
  log "making the $CHANGES-change repo"
  python3 -I "$HERE/bigboard_repo.py" "$FIXTURE/repo" "$CHANGES" || exit 1
  touch "$ST/repo.done"
fi

# a run cut inside the messages-and-tasks stage: its half is thrown away with the data folder, so nothing is posted twice
if [[ -f "$ST/msgs.started" && ! -f "$ST/msgs.done" ]]; then
  log "the last run was cut inside the messages and tasks: starting them again on a fresh data folder"
  rm -rf -- "$FIXTURE/data" "$ST/env" "$ST/agents.done" "$ST/msgs.started" "$ST/uploads.ledger" "$ST/uploads.done"; mkdir -p "$ST/env"
fi

# 3. the seed server
coral_test_sandbox
mkdir -p "$FIXTURE/data"
start_server() {
  log "starting the seed server on $PORT"
  env -u TMUX -u CORAL_CLOUD_URL -u CORAL_URL -u CORAL_SESSION_NAME -u CORAL_SUBSCRIBER_ID -u CORAL_SESSION_TOKEN -u CLAUDE_PROJECTS_DIR \
    HOME="$CORAL_TEST_HOME" USERPROFILE="$CORAL_TEST_HOME" PATH="$FIXTURE/bin:$CORAL_TEST_STUB_BIN:$PATH" CORAL_DATA_DIR="$FIXTURE/data" CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1 \
    MOCK_AGENT_ENV_DUMP="$ST/env" CODEX_HOME="$CORAL_TEST_HOME/codex" \
    "$WORK/seedbin/coral" --home "$FIXTURE/data" --no-browser --host 127.0.0.1 --port "$PORT" --cloud-url off >>"$WORK/server.log" 2>&1 &
  SRV=$!
  for _ in $(seq 240); do
    kill -0 "$SRV" 2>/dev/null || { log "server exited"; tail -20 "$WORK/server.log"; exit 1; }
    curl -s -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null && break
    sleep 0.5
  done
}
start_server
KEY="$(tr -d '[:space:]' < "$FIXTURE/data/api_key" 2>/dev/null)"; [[ -n "$KEY" ]] || { log "no API key"; exit 1; }
printf '%s\n' "$KEY" > "$WORK/key.txt"; chmod 600 "$WORK/key.txt"
BASE="http://127.0.0.1:$PORT"
api() { local m="$1" p="$2"; shift 2; command curl -s -m 600 -X "$m" "$BASE$p" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" "$@"; }
api PUT /api/settings -d "{\"cli_path_claude\": \"$FIXTURE/bin/mock-agent\"}" >/dev/null

# 4. the agents (one team, on the seeded board), working in the big repo; launch_agents PREFIX launches AGENTS mock agents named PREFIX-<i>
launch_agents() {
  local prefix="$1" agents="" i n
  log "launching $AGENTS mock agents ($prefix-N)"
  for i in $(seq "$AGENTS"); do agents="$agents${agents:+,}{\"agent_type\":\"claude\",\"name\":\"$prefix-$i\",\"prompt\":\"You are agent $i.\"}"; done
  api POST /api/sessions/launch-team -d "{\"board_name\":\"bigboard\",\"working_dir\":\"$FIXTURE/repo\",\"agents\":[$agents]}" > "$WORK/launch-$prefix.json"
  for _ in $(seq 120); do n=$(ls "$ST/env" 2>/dev/null | grep -c '\.env$'); [[ "$n" -ge "$AGENTS" ]] && break; sleep 1; done
  log "$(ls "$ST/env" | grep -c '\.env$') of $AGENTS agents have a token"
}
if [[ -f "$ST/agents.done" ]]; then log "agents: launched by an earlier run (their tokens are tried; new ones only if refused)"; else launch_agents agent; touch "$ST/agents.done"; fi

# 5. messages and tasks (the real API, the existing seeder), then uploads
BOARD_ID="$(api GET /api/board/projects | python3 -c 'import sys,json; d=json.load(sys.stdin); p=d if isinstance(d,list) else d.get("projects",[]); print(next((x.get("project") or x.get("id") for x in p if "bigboard" in json.dumps(x)), "bigboard"))')"
if [[ -f "$ST/msgs.done" ]]; then log "messages and tasks: done already"; else
  touch "$ST/msgs.started"
  log "seeding board $BOARD_ID: $MSGS messages, $TASKS tasks"
  SEED_NAMES="$(seq -s, -f "agent-%g" 1 "$AGENTS")" python3 -I "$HERE/scale_seed.py" "$BASE" "$WORK/key.txt" "$BOARD_ID" "$MSGS" "$TASKS" "$ST/seed.json" || exit 1
  touch "$ST/msgs.done"
fi
RELAUNCHED=0
run_uploads() { python3 -I "$HERE/bigboard_uploads.py" "$BASE" "$ST/env" "$FILES" "$VERSIONS" "$WORK/uploads.json" "$ST/uploads.ledger" & UP=$!; wait "$UP"; local rc=$?; UP=""; return $rc; }
if [[ -f "$ST/uploads.done" ]]; then log "uploads: done already"; up=0; else
  log "uploading $FILES files x $VERSIONS versions ($(cat "$ST/uploads.ledger" 2>/dev/null | wc -l | tr -d ' ') already recorded)"
  run_uploads; up=$?
  if [[ $up -eq 3 ]]; then   # the agents' tokens were refused: their sessions did not survive the stop
    log "tokens refused: launching new agents once and going on"
    rm -f "$ST/env"/*.env; launch_agents agentr; RELAUNCHED=1
    run_uploads; up=$?
  fi
  [[ $up -eq 0 ]] && touch "$ST/uploads.done"
fi

# 6. stop, record
for _ in 1 2 3; do api GET /api/sessions/live > "$WORK/live.json"; done
kill "$SRV" 2>/dev/null; for _ in $(seq 120); do kill -0 "$SRV" 2>/dev/null || break; sleep 0.5; done; SRV=""
[[ -S "$FIXTURE/data/tmux.sock" ]] && tmux -S "$FIXTURE/data/tmux.sock" kill-server 2>/dev/null
[[ $up -eq 0 ]] || { log "uploads did not finish (exit $up): run the same command again to resume"; exit 1; }
python3 -I - "$WORK" "$FIXTURE" "$BOARD_ID" "$FILES" "$VERSIONS" "$AGENTS" "$TASKS" "$MSGS" "$CHANGES" "$RELAUNCHED" <<'PY'
import json, sys
work, fx, board, files, vers, agents, tasks, msgs, changes, relaunched = sys.argv[1:]
rows = json.load(open(work + "/live.json")); rows = rows if isinstance(rows, list) else rows.get("sessions", [])
landed = sum(1 for _ in open(fx + "/.seed/uploads.ledger"))
json.dump({"board": board, "files": int(files), "versions": int(vers), "uploads_recorded": landed, "agents_asked": int(agents), "agents_relaunched_once": relaunched == "1",
           "agent_rows_at_end": len(rows), "tasks_asked": int(tasks), "messages_asked": int(msgs), "changes": int(changes),
           "seed": json.load(open(fx + "/.seed/seed.json"))}, open(fx + "/fixture.json", "w"), indent=1)
PY
touch "$ST/complete"
du -sk "$FIXTURE/data" | awk '{printf "[bigboard] data folder %.0f MB\n", $1/1024}'
head -30 "$FIXTURE/fixture.json"
log "done: $FIXTURE"
