#!/bin/bash
# Start a fresh isolated demo Coral (no session, mock agents, throwaway data), optionally launch the team, and sign in headless.
# Needs $DEMO_ROOT/bin (coral, coral-board, coral-agent, mock-agent, coral-hook-*; see README) and Playwright in $DEMO_ROOT.
# usage: rig-up.sh        start a fresh one;   rig-up.sh stop    stop it (only if the recorded pid is still this demo's own server)
# NOLAUNCH=1 leaves the team to the take (beat 2 launches it on camera).
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
SEED="$HERE/../seed"
# Stop the demo Coral recorded in work/server.pid, but only if that pid is still this demo's own server (our binary on our port):
# a pid that was reused by anything else is left alone.
stop_demo() {
  local pf="$S/work/server.pid" pid cmd
  [ -f "$pf" ] || return 0
  pid=$(cat "$pf")
  case "$pid" in ''|*[!0-9]*) rm -f "$pf"; return 0 ;; esac
  cmd=$(ps -p "$pid" -o command= 2>/dev/null)
  if [ -n "$cmd" ] && [[ "$cmd" == "$S/bin/coral "* ]] && [[ "$cmd" == *"--port $PORT"* ]]; then kill "$pid"; sleep 1
  elif [ -n "$cmd" ]; then echo "pid $pid is not this demo's Coral; not stopping it" >&2; fi
  rm -f "$pf"
}
if [ "$1" = stop ]; then stop_demo; exit 0; fi
stop_demo
mkdir -p "$S/work"; rm -rf "$S/data" "$S/home" "$S/repo" "$S/work/claude-projects" "$S/work/envdump" "$S/work/state.json" "$S/work/launch.json"
mkdir -p "$S/data" "$S/home" "$S/repo" "$S/work/claude-projects" "$S/work/envdump"
# the throwaway Go package the agents "work on"
( cd "$S/repo" && git init -q -b main . && printf 'package slug\n\n// Slug lowercases s and joins words with dashes.\nfunc Slug(s string) string { return s }\n' > slug.go \
  && printf 'module example.com/slug\n\ngo 1.22\n' > go.mod && git add . && git -c user.name=Demo -c user.email=demo@example.invalid commit -qm "Start the slug package" )
cd "$S/home"
nohup env -i HOME="$S/home" PATH="$S/bin:/usr/bin:/bin" CORAL_DATA_DIR="$S/data" CORAL_TELEMETRY_DISABLED=1 CORAL_HOOK_DIR="$S/bin" \
  MOCK_AGENT_READY=1 MOCK_AGENT_ENV_DUMP="$S/work/envdump" CLAUDE_PROJECTS_DIR="$S/work/claude-projects" \
  "$S/bin/coral" --host 127.0.0.1 --port "$PORT" --cloud-url off --no-browser --backend pty > "$S/work/server.log" 2>&1 &
echo $! > "$S/work/server.pid"; sleep 4
KEY=$("$HERE/denv.sh" coral api-key 2>&1 | tail -1); (umask 077; echo "$KEY" > "$S/work/key")
curl -s -m 5 -X PUT "http://127.0.0.1:$PORT/api/settings" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"cli_path_claude\": \"$S/bin/mock-agent\"}" >/dev/null
PW=$(python3 -I -c "import secrets;print(secrets.token_hex(8))")   # a random one-run password; the demo Coral is thrown away
printf '%s\n%s\n' "$PW" "$PW" | "$HERE/denv.sh" coral set-password --stdin --url "http://127.0.0.1:$PORT" --home "$S/data" >/dev/null 2>&1
if [ -z "$NOLAUNCH" ]; then
  curl -s -m 30 -X POST "http://127.0.0.1:$PORT/api/sessions/launch-team" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "{\"board_name\":\"slug-team\",\"working_dir\":\"$S/repo\",\"agents\":[{\"agent_type\":\"claude\",\"name\":\"Orchestrator\",\"prompt\":\"Sample agent.\"},{\"agent_type\":\"claude\",\"name\":\"Developer\",\"prompt\":\"Sample agent.\"},{\"agent_type\":\"claude\",\"name\":\"Reviewer\",\"prompt\":\"Sample agent.\"}]}" > "$S/work/launch.json"
  sleep 3
fi
URL=$("$HERE/denv.sh" coral open --print 2>&1 | grep -o 'http[^ ]*')
PLAYWRIGHT_BROWSERS_PATH="$S/pw-browsers" node "$HERE/login.mjs" "$URL" 2>&1 | tail -1
