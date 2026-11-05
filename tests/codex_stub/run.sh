#!/bin/sh
# A real Codex CLI run against a loopback stub model: no login, a throwaway CODEX_HOME, nothing read from the person's ~/.codex (#13732).
# usage: run.sh "<prompt>" '<json list of shell command lines, one per model turn>'
# The stub (stub.js) speaks the Responses API on 127.0.0.1 and answers turn N with an exec_command call (Codex 0.166's shell tool) for the Nth command, then "done".
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d /private/tmp/codex-stub.XXXXXX)
mkdir -p "$root/home" "$root/work"
port=${STUB_PORT:-18791}
cat > "$root/home/config.toml" <<TOML
model = "stub-model"
model_provider = "stub"
[model_providers.stub]
name = "stub"
base_url = "http://127.0.0.1:$port/v1"
wire_api = "responses"
requires_openai_auth = false
TOML
STUB_PORT=$port STUB_CALLS=${2:-'["echo hello"]'} node "$here/stub.js" > "$root/stub.out" 2> "$root/stub.err" &
stub=$!
trap 'kill $stub 2>/dev/null; rm -rf "$root"' EXIT
sleep 1
# env -i: the run sees nothing of the caller's environment, and HOME is the throwaway folder, so ~/.codex/auth.json is out of reach
( cd "$root/work" && env -i PATH="$PATH" HOME="$root/home" CODEX_HOME="$root/home" codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "${1:-run it}" < /dev/null )
echo "stub requests: $(grep -c 'POST /v1/responses' "$root/stub.err")"
