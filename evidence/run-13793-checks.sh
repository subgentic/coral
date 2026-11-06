#!/bin/zsh
set -eu
cd "${0:A:h}/.."
log=/private/tmp/ui13793-browser.log
coral-board resource claim mac-heavy --wait --timeout 90m --note '#13793 account override/fallback: one browser suite, Go, full static'
finish() {
 result=$?
 coral-board resource release mac-heavy
 if (( result != 0 )); then
  coral-agent artifact upload "$log" --task 13793 --tag internal
  coral-board post --task 13793 "@Orchestrator #13793 check failed (exit $result), log uploaded. I am inspecting the failure."
 fi
}
trap finish EXIT
node tests/frontend/run_cdp_suites.mjs --only hub_account_flags_browser --shards 1 --retries 0 --results-out /private/tmp/ui13793-browser-results.json > "$log" 2>&1
log=/private/tmp/ui13793-go.log
(cd coral-go && go test -p 4 ./pkg/frontend) > "$log" 2>&1
log=/private/tmp/ui13793-static.log
npm --prefix tests/frontend run test:cloud > "$log" 2>&1
