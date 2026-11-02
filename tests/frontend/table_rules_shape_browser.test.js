// cdp-timeout: 400 (the shape half of the table rules check: every synthetic table surface, 4 mixes at 4 widths, 200% text, kept widths, the first and last column's drag and keyboard at 1440, and a phone; #11943, split from table_rules_browser by #12327)
// The check itself is helpers/table_rules_check.js. This half mounts each table shape (a spec per surface in that file: analytics, files, tasks, goals, servers, settings, skills, skill files, activity) as a synthetic page; the live surfaces are table_rules_live_browser.
require('./helpers/table_rules_check').run('shape');
