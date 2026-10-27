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
assert.equal(snippetOf('## Report 7\n\nA table:\n\n| name | value |\n|------|-------|\n| a | 1 |\n\n---\n\nAnd the end.'), 'Report 7 A table: And the end.', 'a Markdown table and a rule are no words');

assert.deepEqual(taskRefs('See #7740, #7757 and #7740 again; not C#, not a#b, not http://x/#12, not #123456789'), ['7740', '7757']);
assert.deepEqual(taskRefs('```\n#99\n```'), []);

const t = tagsOf({ content: 'Question for @Backend Dev and @QA Engineer and @Orchestrator: @Operator #7757', ask: { open: ['Backend Dev'] } });
assert.deepEqual(t.mentions.map(m => m.name), ['Backend Dev', 'QA Engineer', 'Orchestrator', 'Operator']); assert.equal(t.task, '7757'); assert.equal(t.ask, true); assert.equal(t.mine, true);
assert.equal(tagsOf({ content: 'a@b.com no mention' }).mentions.length, 0, 'an email is no mention');
assert.equal(tagsOf({ content: '`@Backend Dev` in code' }).mentions.length, 0, 'code is not read');
assert.equal(tagsOf({ content: 'x' }).ask, false);

const { layoutChips, chipsOf } = await importUi('board_table');
const many = chipsOf({ content: '@Backend Dev @QA Engineer please look at #7790', ask: { open: ['Backend Dev'] } }, tagsOf({ content: '@Backend Dev @QA Engineer please look at #7790', ask: { open: ['Backend Dev'] } }, { replyName: 'Lead Developer' }));
assert.deepEqual(many.map(c => c.t), ['Reply to Lead Developer', '@Backend Dev', '@QA Engineer', '#7790', 'Question']);
const head = layoutChips(many), full = layoutChips(many, { all: true });
assert.equal((head.match(/class="chip chip-tag mb-row-tag /g) || []).length + (head.match(/mb-ask-badge/g) || []).length, 3, 'more than three marks: the first mention, the Question badge and a +N pill');
assert.ok(head.includes('>+3</span>') && head.includes('title="Reply to Lead Developer, @QA Engineer, #7790"') && head.includes('aria-label="3 more: Reply to Lead Developer, @QA Engineer, #7790"') && head.includes('@Backend Dev') && head.includes('Question'), head);
assert.ok(['Reply to Lead Developer', '@Backend Dev', '@QA Engineer', '#7790', 'Question'].every(w => full.includes(w)) && !full.includes('more-tag'), 'the open message draws every mark');
assert.ok(!layoutChips(many.slice(0, 3)).includes('more-tag'), 'three marks fit: no pill');
assert.ok(layoutChips([many[0], many[1], many[2], many[3]]).includes('>+3</span>') && layoutChips([many[0], many[1], many[2], many[3]]).includes('@Backend Dev'), 'no Question: the first mention, then +N');

const { applyAskUpdates } = await importUi('board_table');
{ // the server's ask_updates replace the Question's ask of a loaded message
    const all = [{ id: 1, content: 'q', ask: { to: ['Backend Dev'], open: ['Backend Dev'], answered: false } }, { id: 2, content: 'plain' }];
    assert.deepEqual(applyAskUpdates(all, [{ id: 9, ask: { open: [] } }, { id: 1 }, null, { id: 2, ask: 'x' }]), [], 'an unknown id, no ask and junk change nothing');
    assert.equal(applyAskUpdates(all, [{ id: 1, ask: { to: ['Backend Dev'], open: ['Backend Dev'], answered: false } }]).length, 0, 'the same state is no change');
    const changed = applyAskUpdates(all, [{ id: 1, ask: { to: ['Backend Dev'], open: [], answered: true } }]);
    assert.equal(changed.length, 1); assert.deepEqual(all[0].ask, { to: ['Backend Dev'], open: [], answered: true });
    assert.deepEqual(applyAskUpdates(all, undefined), [], 'a page with no updates');
}

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
assert.equal(p.actions, '', 'a collapsed row has no actions (a long board is a lot of rows)'); assert.ok(/data-more="Actions &quot;x&quot;"/.test(p.attrs), p.attrs);
// open rows are remembered by id (no DOM here: a stand-in row)
const row = { dataset: { messageId: '7' }, classList: { toggle() {}, contains: () => false }, querySelector: () => null, insertAdjacentHTML() {}, getAttribute: () => null, hasAttribute: () => false, parentElement: null };
toggleRow(row, true); assert.equal(isRowOpen(7), true);
const open = rowParts({ id: 7, content: 'hi' }, { agent: 'A', timeHtml: '', moreLabel: 'm' });
assert.ok(/data-msg-id="7"/.test(open.actions) && /Reply/.test(open.actions) && /mb-open/.test(open.classes), 'an open row has its actions');
const dock = rowParts({ id: 7, content: 'hi' }, { agent: 'A', timeHtml: '', moreLabel: '', more: false }); assert.ok(!/mb-row-more/.test(dock.actions) && dock.attrs === '', 'the dock has no More'); toggleRow(row, false); assert.equal(isRowOpen(7), false);
console.log('board_table: ok');
