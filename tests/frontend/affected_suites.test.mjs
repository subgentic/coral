// The affected-suites finder (#17652): a diff that rewords text lists the suites that still assert the old words, and leaves out the ones that do not; a changed helper lists its importers.
import assert from 'node:assert/strict';
import { removedTokens, affected, tokensOf } from './affected_suites.mjs';

const diff = `diff --git a/coral-go/pkg/frontend/static/modes.js b/coral-go/pkg/frontend/static/modes.js
--- a/coral-go/pkg/frontend/static/modes.js
+++ b/coral-go/pkg/frontend/static/modes.js
@@ -3 +3 @@
-const hint = 'Auto mode decides for you';
+const hint = 'Auto mode asks first';
-const keep = 'Stays the same';
+const keep = 'Stays the same'; // note
diff --git a/tests/frontend/helpers/wait.js b/tests/frontend/helpers/wait.js
--- a/tests/frontend/helpers/wait.js
+++ b/tests/frontend/helpers/wait.js
@@ -1 +1 @@
-x
+y
diff --git a/tests/frontend/own_browser.test.js b/tests/frontend/own_browser.test.js
--- a/tests/frontend/own_browser.test.js
+++ b/tests/frontend/own_browser.test.js
@@ -1 +1 @@
-'Auto mode decides for you'
+'Auto mode asks first'
`;
const t = removedTokens(diff);
assert.deepEqual([...t.tokens.keys()], ['Auto mode decides for you'], 'the reworded string is removed; the unchanged one and the test file are not');
assert.deepEqual(t.helpers, ['tests/frontend/helpers/wait.js']);
const suites = new Map([
    ['tests/frontend/cli_dialogs_browser.test.js', "assert(text.includes('Auto mode decides for you'))"],
    ['tests/frontend/other_browser.test.js', "const { coralReady } = require('./helpers/wait');"],
    ['tests/frontend/unrelated_browser.test.js', "assert(1)"],
]);
const hit = affected(t, suites);
assert.deepEqual([...hit.keys()], ['tests/frontend/cli_dialogs_browser.test.js', 'tests/frontend/other_browser.test.js'], 'the asserting suite and the helper importer; not the unrelated one');
assert.match(hit.get('tests/frontend/other_browser.test.js')[0], /imports tests\/frontend\/helpers\/wait\.js/);
assert.deepEqual(tokensOf('<button class="btn btn-small sched-more-btn" aria-label="More for x">Turn off now</button>').sort(), ['More for x', 'Turn off now', 'btn btn-small sched-more-btn', 'btn-small', 'sched-more-btn'].filter(s => s.length >= 6).sort());
// #16357: the diff removed 'Everything, with safety checks.' and two suites said it lower-cased inside a longer sentence
const re = affected({ tokens: new Map([['Everything, with safety checks.', 'permission_flags.js']]), helpers: [] }, new Map([['tests/frontend/a_browser.test.js', "'Auto mode: everything, with safety checks.'"]]));
assert.deepEqual([...re.keys()], ['tests/frontend/a_browser.test.js'], 'a case difference and a longer sentence still match');
// a helper's name is text, not a pattern: wait+.js must not match waitttjs
assert.equal(affected({ tokens: new Map(), helpers: ['tests/frontend/helpers/a+b.js'] }, new Map([['tests/frontend/x_browser.test.js', "require('./helpers/aab')"]])).size, 0, 'the + is not a quantifier');
console.log('PASS the affected-suites finder lists what a reworded string breaks');
