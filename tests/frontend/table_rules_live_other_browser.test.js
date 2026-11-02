// cdp-timeout: 600 (the live table rules check, Analytics' tables and the self-hosted Hub's computers: each reloads the whole page for its data world; #11943, split by #12327)
// The check itself is helpers/table_rules_check.js; the other halves are table_rules_shape_browser and table_rules_live_inbox_browser.
require('./helpers/table_rules_check').run('analytics|servers');
