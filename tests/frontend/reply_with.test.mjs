// #9054: a message from another board shows the server's own line on how to answer it (reply_with), escaped; any other message shows nothing.
import assert from 'node:assert/strict';
process.env.CORAL_TELEMETRY_DISABLED = '1'; // nothing here starts a Coral, but the telemetry census wants it in every script that names coral-board
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom();
const { replyWithHtml } = await importUi('board_message_text');

const line = 'Reply with: coral-board send --board design-team --reply-to 812 "..."';
const html = replyWithHtml({ id: 812, reply_with: line });
assert.match(html, /class="mb-reply-with"/);
assert.match(html, /Reply with: <code>coral-board send --board design-team --reply-to 812 &quot;\.\.\.&quot;<\/code>/);

// the board name is the other team's text: it is escaped
const hostile = replyWithHtml({ reply_with: 'Reply with: coral-board send --board \'<img src=x onerror=alert(1)>\' --reply-to 1 "..."' });
assert.ok(!hostile.includes('<img'), hostile);
assert.match(hostile, /&lt;img/);

// a line that is not in the usual form is shown as text, still escaped
assert.match(replyWithHtml({ reply_with: '<b>x</b>' }), /&lt;b&gt;x&lt;\/b&gt;/);

for (const m of [null, undefined, {}, { reply_with: '' }, { reply_with: '   ' }, { reply_with: 5 }]) assert.equal(replyWithHtml(m), '', JSON.stringify(m));
console.log('reply_with: ok');
