#!/bin/bash
# Run a CLI as one of the demo's mock agents (Orchestrator, Developer or Reviewer), against the demo Coral only.
# usage: DEMO_ROOT=... asagent.sh Developer coral-board post "..."
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
NAME="$1"; shift
SID=$(python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));print(next(a['session_id'] for a in d['agents'] if a['name']==sys.argv[2]))" "$S/work/launch.json" "$NAME") || exit 1
cd "$S/repo" || exit 1
ENVS=(); while IFS= read -r kv; do [ -n "$kv" ] && ENVS+=("$kv"); done < "$S/work/envdump/$SID.coralenv"
exec env -i HOME="$S/home" PATH="$S/bin:/usr/bin:/bin" CORAL_URL="http://127.0.0.1:$PORT" CORAL_TELEMETRY_DISABLED=1 "${ENVS[@]}" "$@"
