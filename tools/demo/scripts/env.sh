# Sourced by the other scripts: where the demo's scratch folder is, and its port.
# DEMO_ROOT is a scratch folder you made for this, marked with an empty file named .coral-demo-root (see the README).
# The scripts delete things under it, so it must exist, must not be / or your home folder, and must carry the marker.
: "${DEMO_ROOT:?set DEMO_ROOT to a scratch folder, for example ~/coral-demo-work}"
[ -d "$DEMO_ROOT" ] || { echo "DEMO_ROOT is not a folder: $DEMO_ROOT" >&2; exit 2; }
S="$(cd "$DEMO_ROOT" && pwd)" || exit 2
if [ -z "$S" ] || [ "$S" = / ] || [ "$S" = "$HOME" ]; then echo "refusing DEMO_ROOT=$S: use a folder made for the demo" >&2; exit 2; fi
[ -f "$S/.coral-demo-root" ] || { echo "refusing $S: it has no .coral-demo-root marker (touch it yourself, in an empty folder made for the demo)" >&2; exit 2; }
PORT="${DEMO_PORT:-8471}"
if [ "$PORT" = 8420 ]; then echo "refusing port 8420 (a real Coral's port)" >&2; exit 2; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
