// #13383 (UI Reviewer's SHOULD on #13299): the late-answer rule of the comments panel's live poll, as a node-level test in test:cloud. The panel (artifact_comments.js, attachComments) reads its thread on a timer; an answer
// is used only by the context it was asked under: ctxGen moves on every open and close, and a late answer must match it (and the file, computer, team and series). A poll that is still in flight when the viewer closes and
// opens the SAME file again (the same hash, computer and team: only the generation tells the two apart) must not draw its answer in the new context; nor may one that lands after a plain close. The real module against a
// stubbed fetch with the answers held and released by the test. Removing the ctxGen checks from liveTick and refresh makes both cases fail (the commit's message says how it was shown).
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom();
globalThis.__coralCommentsPollMs = 15; // the poll's beat, read when a panel is attached (the product's is 8 s)
window.Element.prototype.getClientRects = function () { return [{}]; }; // the poll reads only a panel that is on screen; jsdom has no layout, so say it is
const HEX = 'f'.repeat(64);
const thread = (...bodies) => ({ comments: bodies.map((body, i) => ({ id: i + 1, parent_id: null, anchor: { whole: true }, body, author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: new Date().toISOString(), can: { reply: true, edit: true, delete: true, resolve: true } })), locked: false, you: { kind: 'owner', name: 'Operator', can_comment: true, can_lock: true } });
const answer = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });

// what the server says now, and the one answer the test holds back
let current = thread('First context thread'), held = null, calls = 0;
globalThis.fetch = window.fetch = (url) => {
    assert.ok(String(url).includes(`/api/artifacts/${HEX}/comments`), 'only the comments route is read: ' + url);
    calls++;
    if (held && held.armed) { held.armed = false; return held.promise; } // the next read is held: it is answered when the test lets it go
    return Promise.resolve(answer(current));
};
const hold = payload => { let release; const promise = new Promise(r => { release = () => r(answer(payload)); }); held = { armed: true, promise, release }; return held; };
const settle = ms => new Promise(r => setTimeout(r, ms));
const drained = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); }; // every promise step of a released answer, no timer beat in between
const until = async (what, test, ms = 1500) => { const t0 = Date.now(); while (!test()) { if (Date.now() - t0 > ms) assert.fail('timed out waiting for ' + what); await settle(5); } };

const { attachComments } = await importUi('artifact_comments');
const dialog = document.createElement('div'), body = document.createElement('div'), host = document.createElement('div');
document.body.append(dialog, host);
const comments = attachComments(dialog, body, host, { toggleHost: true, sheet: () => false, shown: () => true, words: { empty: 'No comments.', whole: 'Comment', quote: 'This' } });
const panelText = () => (host.querySelector('.ac-panel')?.textContent || '');
const openFile = async (n) => { const want = { 1: 'First context thread', 2: 'Second context thread', 3: 'Third context thread' }[n]; comments.open(HEX, undefined, 'team-a'); comments.docWhole(); comments.setSheet(true); await until(`the thread of context ${n}`, () => panelText().includes(want)); };

// 1. the same file closed and opened again while a poll of the first context is still in flight
await openFile(1);
const slow = hold(thread('First context thread', 'LATE ANSWER of the first context'));
await until('a poll to be held in flight', () => !slow.armed);
const before = calls;
comments.close();
current = thread('Second context thread');
await openFile(2);
slow.release(); // the first context's answer arrives now, after the second one drew
await drained(); // read before the next beat: a wrongly accepted answer would be drawn here, and the next poll of the second context would heal it (so a later look could not see it)
assert.ok(!panelText().includes('LATE ANSWER'), 'the late answer of the context it replaced is not drawn, read right after it landed: ' + panelText().slice(0, 200));
await settle(150); // the beat is 15 ms: several polls of the second context run after it
assert.ok(calls > before, 'the second context kept reading');
assert.ok(panelText().includes('Second context thread') && !panelText().includes('LATE ANSWER'), 'the reopened panel shows its own thread: ' + panelText().slice(0, 200));

// 2. a poll in flight when the viewer closes: its answer does not draw anything after the close
const slow2 = hold(thread('Second context thread', 'LATE ANSWER after the close'));
await until('a second poll to be held in flight', () => !slow2.armed);
comments.close();
const closedText = panelText();
slow2.release();
await drained();
assert.equal(panelText(), closedText, 'a closed panel draws nothing when a late answer lands: ' + panelText().slice(0, 200));
assert.ok(!panelText().includes('LATE ANSWER'), 'the late answer is not in the closed panel');
// 3. the same file opened again WITHOUT a close (the viewer does this when it switches version or reloads): the first open's late answer does not draw in the second
current = thread('Second context thread');
await openFile(2);
const slow3 = hold(thread('Second context thread', 'LATE ANSWER of an open without a close'));
await until('a third poll to be held in flight', () => !slow3.armed);
current = thread('Third context thread');
await openFile(3); // no close in between
slow3.release();
await drained();
assert.ok(!panelText().includes('LATE ANSWER'), 'an open without a close moves the generation too: the late answer is not drawn: ' + panelText().slice(0, 200));
await settle(60);
assert.ok(panelText().includes('Third context thread'), 'the panel shows the thread of the open it is on: ' + panelText().slice(0, 200));
comments.close(); // stops the poll's timer, so the process can end (an open panel keeps one running)
console.log('PASS comments_late_answer: a late answer of another context (a closed and reopened file) or after a close is never drawn');
