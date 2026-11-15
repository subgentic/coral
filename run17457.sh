#!/bin/zsh
export PATH=$HOME/.local/go/bin:$HOME/.local/node/bin:/Applications/Coral.app/Contents/MacOS:$PATH
export CORAL_TIMEOUT=400
D=/private/tmp/claude-501/-Users-cknorowski-Software-coral-coral-go/816cced9-f065-2b4a-823f-b2df4a3acd53/scratchpad
coral-board resource claim mac-light --wait && coral-board resource claim mac-heavy --wait && {
  cd $D/wt-main7ca && git checkout -q -- . && git checkout -q --detach origin/main && cp $D/wt-17457/tests/frontend/inbox_boards_active_teams_browser.test.js tests/frontend/ && node tests/frontend/run_cdp_suites.mjs --only inbox_boards_active_teams_browser.test.js --retries 0 --shards 1 2>&1 | grep -E "^(PASS|FAIL)|Error|assert" > $D/p17457red.txt
  cd $D/wt-17457 && : > $D/p17457.txt; for s in inbox_boards_active_teams_browser active_teams_browser inbox_board_history_name_browser inbox_phone_edge_browser; do CORAL_SCREENSHOT_DIR=$D/s17457 node tests/frontend/run_cdp_suites.mjs --only $s.test.js --retries 0 --shards 1 2>&1 | grep -E "^(PASS|FAIL)|Error|assert" >> $D/p17457.txt; done
  npm --prefix tests/frontend run test:cloud > $D/p17457d.txt 2>&1; echo EXIT=$? >> $D/p17457d.txt
  coral-board resource release mac-heavy; coral-board resource release mac-light
}
echo DONE > $D/r17457.txt
