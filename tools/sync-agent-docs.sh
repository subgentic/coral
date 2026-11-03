#!/bin/bash
# Sync agent_docs/ to the embedded static directory, each doc gzipped (<name>.md.gz): the docs are 848 KB of Markdown and 315 KB gzipped, and every
# Coral binary carries them (#12865). The server reads the .gz copies as the plain <name>.md files (internal/server/agent_docs_gz.go, #6814).
# gzip -n leaves out the file name and time, so the same docs give the same bytes.
# Run this before `go build` or `go run` during development.
# Production builds run it too: each build job in .github/workflows/release.yml, before go build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../coral-go/agent_docs"
DST="$SCRIPT_DIR/../coral-go/pkg/frontend/static/agent_docs"

if [ ! -d "$SRC" ]; then
    echo "Error: agent_docs not found at $SRC"
    exit 1
fi

rm -rf "$DST"
mkdir -p "$DST"
count=0
for f in "$SRC"/*; do
    [ -f "$f" ] || continue
    case "$f" in
        *.md) gzip -9 -n -c "$f" > "$DST/$(basename "$f").gz"; count=$((count + 1)) ;;
        *)    cp "$f" "$DST/" ;;
    esac
done
echo "Synced agent_docs → static/agent_docs ($count files, gzipped)"
