// The bulk delete's count of files other teams hold too (#13949): one confirmation is one session. A late answer to an earlier confirmation is dropped, the files asked about are fixed once (the first 20), each is asked once however often the confirmation is
// redrawn, and the words say when more were selected than asked about. node artifact_held.test.mjs
import assert from 'node:assert/strict';
import { heldChecker } from '../../coral-go/pkg/frontend/static/artifact_held.js';

const gate = () => { const reads = []; return { reads, read: key => new Promise(resolve => reads.push({ key, resolve })) }; };
const tick = () => new Promise(r => setTimeout(r, 0));
const keys = n => Array.from({ length: n }, (_, i) => 'f' + String(i).padStart(2, '0'));

// 1. more than 20 selected, delayed reads, redraws: 20 are asked once each, the subset does not move, the words say so
{
    const g = gate(); let changes = 0; const c = heldChecker({ read: g.read, changed: () => changes++ });
    const all = keys(25);
    for (let i = 0; i < 5; i++) assert.equal(c.words(all), '', 'a redraw before any answer says nothing');
    assert.equal(g.reads.length, 20, 'twenty files are asked about, once each, however often the confirmation is drawn: ' + g.reads.length);
    assert.deepEqual(g.reads.map(r => r.key), all.slice(0, 20), 'the first twenty, in the order given');
    c.words([...all].reverse()); // the same selection in another order is the same confirmation
    assert.equal(g.reads.length, 20, 'the same selection in another order starts nothing');
    g.reads[0].resolve(3); g.reads[1].resolve(2); g.reads[2].resolve(1); await tick();
    assert.equal(changes, 3, 'each answer says the words changed');
    assert.equal(c.words(all), ' 2 of these are also in other teams and go there too. (Checked the first 20 of 25.)');
    for (let i = 3; i < 20; i++) g.reads[i].resolve(0); await tick();
    assert.equal(c.words(all).includes('2 of these are'), true);
}
// 2. the same file twice in one selection is one read
{ const g = gate(); const c = heldChecker({ read: g.read }); c.words(['a', 'a', 'b']); assert.equal(g.reads.length, 2, 'a repeated file is one read: ' + g.reads.length); }
// 3. a late answer to a closed confirmation never shows in the next one (cancel, reselect, then the old answer arrives)
{
    const g = gate(); let changes = 0; const c = heldChecker({ read: g.read, changed: () => changes++ });
    c.words(['a', 'b']); const old = g.reads.slice();
    c.end(); // Keep
    c.words(['a', 'b']); const fresh = g.reads.slice(old.length);
    assert.equal(fresh.length, 2, 'the next confirmation asks again');
    old[0].resolve(5); await tick();
    assert.equal(c.words(['a', 'b']), '', 'the old answer is dropped: ' + c.words(['a', 'b']));
    assert.equal(changes, 0, 'and says nothing changed');
    fresh[0].resolve(3); await tick();
    assert.equal(c.words(['a', 'b']), ' 1 of these is also in other teams and goes there too.', 'the new answer shows');
}
// 4. a different selection is a new confirmation: the answers of the old one are dropped
{
    const g = gate(); const c = heldChecker({ read: g.read }); c.words(['a', 'b']); const first = g.reads.slice();
    c.words(['a', 'c']); assert.equal(g.reads.length, 4, 'a different selection asks again');
    first[0].resolve(4); await tick();
    assert.equal(c.words(['a', 'c']), '', 'an answer to the earlier selection is not this one\'s');
}
// 5. a read that fails or answers oddly is 'none'
{ const c = heldChecker({ read: async k => { if (k === 'a') throw new Error('no'); return 'x'; } }); c.words(['a', 'b']); await tick(); await tick(); assert.equal(c.words(['a', 'b']), '', 'a failed or odd read says nothing'); }
console.log('PASS artifact_held: a session per confirmation, the first 20 fixed and asked once, late answers dropped');
