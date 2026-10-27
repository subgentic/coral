// A question (post --ask, #7794) is marked on the board: a small "Question" badge, "answered" once each member asked has answered, the title naming who it waits on; a plain message and
// a message with a junk ask field show none; the title is an attribute value, never markup. Run: node board_ask_badge.test.mjs
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom();
const { askBadge } = await importUi('board_message_text');

const open = askBadge({ ask: { to: ['Dev A', 'Dev B'], open: ['Dev B'], answered: false } });
assert.match(open, /^<span class="chip chip-tag mb-external-badge mb-ask-badge" title="A question: waiting on Dev B">Question<\/span>$/);

const done = askBadge({ ask: { to: ['Dev A'], open: [], answered: true } });
assert.match(done, /mb-ask-badge is-answered/);
assert.match(done, />Question · answered<\/span>$/);
assert.match(done, /every one of them has answered/);

assert.equal(askBadge({ content: 'a plain message' }), '', 'a plain message has no badge');
assert.equal(askBadge(null), '');
assert.equal(askBadge({ ask: 'yes' }), '', 'a junk ask field shows none');

const hostile = askBadge({ ask: { open: ['"><img src=x onerror=alert(1)>'], answered: false } });
assert.ok(!hostile.includes('<img'), 'a name is escaped in the attribute: ' + hostile);
assert.ok(hostile.includes('&quot;&gt;&lt;img') || hostile.includes('&#34;&gt;&lt;img'), hostile);

console.log('board_ask_badge: ok');
