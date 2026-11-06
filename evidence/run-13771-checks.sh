#!/bin/zsh
set -eu
cd "${0:A:h}/.."
mode=${1:-target}
log=/private/tmp/ui13771-${mode}.log
coral-board resource claim mac-heavy --wait --timeout 90m --note "#13771 ${mode}: browser/HEADLESS native script tests; no GUI"
finish() {
 result=$?
 coral-board resource release mac-heavy
 if (( result != 0 )); then
  coral-agent artifact upload "$log" --no-task --tag internal > /private/tmp/ui13771-failure-artifact.json || true
  coral-board post --task 13771 "@Orchestrator #13771 ${mode} stopped with exit ${result}; no webview/AppKit/GUI test ran. Failure log uploaded; I am inspecting it before continuing." || true
 fi
}
trap finish EXIT
if [[ "$mode" == static ]]; then
 npm --prefix tests/frontend run test:cloud > "$log" 2>&1
 exit 0
fi
if [[ "$mode" != baseline ]]; then
 log=/private/tmp/ui13771-native.log
 (cd coral-go/cmd/coral-app && CGO_ENABLED=0 go test -p 4 links.go links_test.go links_managed_test.go downloads.go downloads_test.go) > "$log" 2>&1
 log=/private/tmp/ui13771-${mode}.log
fi
if [[ "$mode" == all ]]; then
 suites=$(node --input-type=module -e 'import fs from "node:fs";console.log(fs.readdirSync("tests/frontend").filter(f=>/^(inbox_|needs_|mailbox_|artifact_).*_browser\.test\.(js|mjs)$/.test(f)).join(","))')
 suites="${suites},native_download_browser,preview_pane_artifact_refs_browser,operator_asks_browser,operator_asks_servers_browser"
elif [[ "$mode" == tag ]]; then
 suites=artifact_question_links_browser,artifact_refs_browser,artifact_viewer_browser,inbox_ask_buttons_real_browser
elif [[ "$mode" == followup ]]; then
 suites=artifact_refs_browser,artifact_viewer_browser,artifact_question_links_browser
else
 suites=artifact_question_links_browser
fi
CORAL_SCREENSHOT_DIR=/private/tmp/ui13771-${mode}-shots node tests/frontend/run_cdp_suites.mjs --only "$suites" --shards 2 --retries 0 --results-out /private/tmp/ui13771-${mode}-results.json > "$log" 2>&1

if [[ "$mode" == all || "$mode" == followup || "$mode" == tag ]]; then
 log=/private/tmp/ui13771-go.log
 (cd coral-go && go test -p 4 ./pkg/frontend) > "$log" 2>&1
 coral-board resource release mac-heavy
 trap - EXIT
 log=/private/tmp/ui13771-static.log
 npm --prefix tests/frontend run test:cloud > "$log" 2>&1 || { coral-agent artifact upload "$log" --no-task --tag internal; coral-board post --task 13771 '@Orchestrator #13771 static checks failed; log uploaded, no commit or review submitted.'; exit 1; }
fi
