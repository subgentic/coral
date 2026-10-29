// removeBoards deletes each board twice, a moment apart (#11000): a write that was in flight at the first DELETE (the board's working mode PUT by a settings toggle) makes the board's row again, and the runner's end-check names the board
// (`board asks-... added (0 messages, 0 tasks, 0 subscribers)`, red in CI only). A fake page records what it is asked.
const assert = require('node:assert/strict');
const { removeBoards, AGAIN_MS } = require('./helpers/board_cleanup');

(async () => {
    const calls = [];
    const ev = async expr => { calls.push({ at: Date.now(), name: /encodeURIComponent\("([^"]+)"\)/.exec(expr)?.[1] || (expr.match(/\\("(.+?)"\\)/) || [])[1] || expr.slice(0, 60) }); return 200; };
    const t0 = Date.now();
    await removeBoards(ev, ['board-a', null, 'board-b']);
    const by = n => calls.filter(c => c.name === n);
    assert.equal(calls.length, 4, 'two boards, each deleted twice (a missing name is skipped): ' + JSON.stringify(calls.map(c => c.name)));
    for (const n of ['board-a', 'board-b']) { const c = by(n); assert.equal(c.length, 2, `${n} is deleted twice`); assert.ok(c[1].at - c[0].at >= AGAIN_MS - 20, `${n}: the second DELETE comes ${AGAIN_MS} ms after the first (${c[1].at - c[0].at})`); }
    const none = []; await removeBoards(async e => { none.push(e); return 200; }, []);
    assert.equal(none.length, 0, 'no boards, no calls, no wait');
    assert.ok(Date.now() - t0 < 5000);
    // a page that throws is not the suite's failure
    await removeBoards(async () => { throw new Error('page gone'); }, ['x']);
    console.log('PASS removeBoards deletes twice, a moment apart');
})().catch(e => { console.error(e); process.exit(1); });
