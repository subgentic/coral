// The board table's pure parts (#7921): a message's snippet, the tasks and members it names, the day lines.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom();
const { snippetOf, taskRefs, tagsOf, dayLabel, sameDay, rowParts, toggleRow, isRowOpen } = await importUi('board_table');
const { setBoardMentionNames } = await importUi('board_message_text');

setBoardMentionNames(['Backend Dev', 'QA Engineer']);

assert.equal(snippetOf('## Heading\n\nSome **bold** and `code` with [a link](https://example.com/x).\n\n```js\nignored()\n```'), 'Heading Some bold and code with a link.');
assert.equal(snippetOf('Run #7740 is green'), 'Run #7740 is green', 'a task number keeps its #');
assert.equal(Array.from(snippetOf('é'.repeat(500))).length, 300, 'cut by characters');
assert.equal(snippetOf(null), '');

assert.deepEqual(taskRefs('See #7740, #7757 and #7740 again; not C#, not a#b, not http://x/#12, not #123456789'), ['7740', '7757']);
assert.deepEqual(taskRefs('```\n#99\n```'), []);

const t = tagsOf({ content: 'Question for @Backend Dev and @QA Engineer and @Orchestrator: @Operator #7757', ask: { open: ['Backend Dev'] } });
assert.deepEqual(t.mentions.map(m => m.name), ['Backend Dev', 'QA Engineer']); assert.equal(t.more, 2); assert.equal(t.task, '7757'); assert.equal(t.ask, true); assert.equal(t.mine, true);
assert.equal(tagsOf({ content: 'a@b.com no mention' }).mentions.length, 0, 'an email is no mention');
assert.equal(tagsOf({ content: '`@Backend Dev` in code' }).mentions.length, 0, 'code is not read');
assert.equal(tagsOf({ content: 'x' }).ask, false);

const now = new Date(2026, 9, 26, 12, 0, 0);
assert.equal(dayLabel(new Date(2026, 9, 26, 1, 0).toISOString(), now), 'Today');
assert.equal(dayLabel(new Date(2026, 9, 25, 23, 59).toISOString(), now), 'Yesterday');
assert.match(dayLabel(new Date(2026, 9, 20, 9, 0).toISOString(), now), /Oct/);
assert.match(dayLabel(new Date(2025, 9, 20, 9, 0).toISOString(), now), /2025/);
assert.equal(dayLabel('nonsense', now), '');
assert.ok(sameDay(new Date(2026, 9, 26, 1).toISOString(), new Date(2026, 9, 26, 23).toISOString()));
assert.ok(!sameDay(new Date(2026, 9, 25, 23).toISOString(), new Date(2026, 9, 26, 0).toISOString()));
assert.ok(!sameDay('x', 'y'));

const p = rowParts({ id: 7, content: '<img src=x onerror=1> hi @Backend Dev', created_at: '2026-10-26T10:00:00Z' }, { agent: '<b>Bad</b>', timeHtml: '<time>1</time>', moreLabel: 'Actions "x"' });
assert.ok(!/<img|<b>/.test(p.toggle + p.actions), 'the sender and the words are escaped');
assert.ok(p.toggle.includes('aria-controls="mbd-7"') && p.toggle.includes('aria-expanded="false"'));
assert.ok(/data-msg-id="7"/.test(p.actions));
// open rows are remembered by id (no DOM here: a stand-in row)
const row = { dataset: { messageId: '7' }, classList: { toggle() {}, contains: () => false }, querySelector: () => null, parentElement: null };
toggleRow(row, true); assert.equal(isRowOpen(7), true); toggleRow(row, false); assert.equal(isRowOpen(7), false);
console.log('board_table: ok');
