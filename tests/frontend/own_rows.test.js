// own_rows: a count over the whole list breaks when another suite's row lands; a count over the suite's own rows does not (#13389).
const assert = require('node:assert/strict');
const { ownRows, settleOwn } = require('./helpers/own_rows');
(async () => {
    const mine = r => r.team === 'ny-1';
    const list = [{ id: 'a', team: 'other' }, { id: 'b', team: 'other' }];
    const baseTotal = list.length, baseOwn = ownRows(list, mine).length;
    list.push({ id: 'r1', team: 'ny-1' });
    list.push({ id: 'foreign', team: 'other-2' }); // lands between the two reads
    assert.notEqual(list.length - baseTotal, 1, 'the whole-list delta is wrong when a foreign row lands (the old pin)');
    assert.equal(ownRows(list, mine).length - baseOwn, 1, 'the own-rows delta is right');
    assert.deepEqual(ownRows(list, { team: 'ny-1' }).map(r => r.id), ['r1'], 'an object matches by fields');
    assert.deepEqual(ownRows(undefined, mine), [], 'no list is no rows');
    let n = 0; const late = async () => (++n < 4 ? 0 : 1);
    assert.equal(await settleOwn(late, 1, { tries: 10, ms: 1 }), 1, 'settle waits for the server to catch up');
    n = 0; assert.equal(await settleOwn(async () => 0, 1, { tries: 3, ms: 1 }), 0, 'settle returns the last value when it never does');
    console.log('own_rows: ok');
})().catch(e => { console.error(e); process.exit(1); });
