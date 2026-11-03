#!/bin/bash
# Run a command against the isolated demo Coral only: no session, its own HOME and data folder, a clean environment.
# usage: DEMO_ROOT=... denv.sh coral api-key
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$S/home" || exit 1
exec env -i HOME="$S/home" PATH="$S/bin:/usr/bin:/bin" CORAL_DATA_DIR="$S/data" CORAL_URL="http://127.0.0.1:$PORT" CORAL_TELEMETRY_DISABLED=1 "$@"
