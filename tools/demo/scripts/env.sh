# Sourced by the other scripts: where the demo's scratch folder is, and its port.
# DEMO_ROOT is any empty folder you own (never ~/.coral): the built tools, the demo Coral's data, clips and shots live in it.
: "${DEMO_ROOT:?set DEMO_ROOT to a scratch folder, for example ~/coral-demo-work}"
S="$(cd "$DEMO_ROOT" && pwd)"
PORT="${DEMO_PORT:-8471}"
if [ "$PORT" = 8420 ]; then echo "refusing port 8420 (a real Coral's port)" >&2; exit 2; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
