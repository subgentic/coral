#!/bin/bash
# Start a fresh isolated demo Coral (no session, mock agents, throwaway data), optionally launch the team, and sign in headless.
# Needs $DEMO_ROOT/bin (coral, coral-board, coral-agent, mock-agent, coral-hook-*; see README) and Playwright in $DEMO_ROOT.
# usage: rig-up.sh        start a fresh one;   rig-up.sh stop    stop it (only if the recorded pid is still this demo's own server)
# NOLAUNCH=1 leaves the team to the take (beat 2 launches it on camera).
# RESUME=1 starts the server again on the data a stopped rig left (to re-take one beat that needs only the data, such as Analytics): nothing is wiped.
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
if [ -z "$RESUME" ]; then
  mkdir -p "$S/work"; rm -rf "$S/data" "$S/home" "$S/work/claude-projects" "$S/work/envdump" "$S/work/state.json" "$S/work/launch.json"
  mkdir -p "$S/data" "$S/home" "$S/work/claude-projects" "$S/work/envdump"
# the throwaway project the agents "work on" (story.json)
  node "$HERE/setup.mjs" repo || exit 1
fi
cd "$S/home"
# the scripted answers of the mock agents (MOCK_AGENT_REPLIES): one entry per agent, keyed by its [Name] tag, from story.json
python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));print(json.dumps([c['reply'] for c in d['chats']]+[{'text':x} for x in d.get('fillers',[])]))" "$HERE/../story.json" > "$S/work/replies.json"
python3 -I -c "import json,sys;print(json.dumps(json.load(open(sys.argv[1]))['mockPrompts']))" "$HERE/../story.json" > "$S/work/prompts.json"   # the words of the prompts the mock raises (MOCK_PROMPTS_FILE)
nohup env -i HOME="$S/home" PATH="$S/bin:/usr/bin:/bin" CORAL_DATA_DIR="$S/data" CORAL_TELEMETRY_DISABLED=1 CORAL_HOOK_DIR="$S/bin" \
  MOCK_AGENT_READY=1 MOCK_AGENT_MODELS=1 MOCK_AGENT_QUIET=1 MOCK_PROMPTS_FILE="$S/work/prompts.json" MOCK_AGENT_REPLIES="$S/work/replies.json" MOCK_AGENT_ENV_DUMP="$S/work/envdump" CLAUDE_PROJECTS_DIR="$S/work/claude-projects" \
  "$S/bin/coral" --host 127.0.0.1 --port "$PORT" --cloud-url off --no-browser --backend pty > "$S/work/server.log" 2>&1 &
echo $! > "$S/work/server.pid"; sleep 4
KEY=$("$HERE/denv.sh" coral api-key 2>&1 | tail -1); (umask 077; echo "$KEY" > "$S/work/key")
curl -s -m 5 -X PUT "http://127.0.0.1:$PORT/api/settings" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"cli_path_claude\": \"$S/bin/mock-agent\"}" >/dev/null
PW=$(python3 -I -c "import secrets;print(secrets.token_hex(8))")   # a random one-run password; the demo Coral is thrown away
printf '%s\n%s\n' "$PW" "$PW" | "$HERE/denv.sh" coral set-password --stdin --url "http://127.0.0.1:$PORT" --home "$S/data" >/dev/null 2>&1
if [ -z "$NOLAUNCH" ] && [ -z "$RESUME" ]; then node "$HERE/setup.mjs" launch; sleep 3; fi
URL=$("$HERE/denv.sh" coral open --print 2>&1 | grep -o 'http[^ ]*')
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$S/pw-browsers}" node "$HERE/login.mjs" "$URL" 2>&1 | tail -1
