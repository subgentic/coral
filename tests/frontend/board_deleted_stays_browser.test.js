// #12995: a board deleted elsewhere while its page is open stays deleted. The page's next subscribe of the Operator is refused (404 board_deleted), the page says "This team was deleted." and stops polling,
// and nothing starts the board again; an agent that joins the same name starts a board on purpose, and that works. Chrome over CDP against the isolated dev server; the board is real.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const B = 'bds-' + Date.now().toString(36);
    const api = `/api/board/${B}`;
    const J = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const call = (path, init, body) => ev(`fetch(${JSON.stringify(api + path)}, ${JSON.stringify({ ...init, body: body ? JSON.stringify(body) : undefined })}).then(r => r.status)`);
    const listed = () => ev(`fetch('/api/board/projects').then(r => r.json()).then(p => (Array.isArray(p) ? p : p.projects || []).some(x => x.project === ${JSON.stringify(B)}))`);
    try {
        await Page.enable();
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        let l = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' }); await l;
        assert.equal(await call('/messages', J, { subscriber_id: 'qa', as: 'QA Engineer', content: 'a board to delete' }), 200);
        l = Page.loadEventFired(); await Page.navigate({ url: `${BASE}/board/${B}` }); await l;
        await coralReady(ev);
        await waitFor(`!!document.getElementById('mb-delete-btn')`, 'the team page', 15000);
        // The board's first page of messages must be on screen before the delete: while it is still loading, showing the tab again reloads the messages (message_board.js: `again` is false until bs._loadedProject is set) and that reply can replace the words below (CI flake, ci/2.0.41 part 1, #12995).
        await waitFor(`(document.getElementById('mb-messages') || {}).textContent.includes('a board to delete')`, 'the board\'s first messages', 15000);

        console.log('1. The board is deleted elsewhere (the API) while the page stays open');
        assert.equal(await call('', { method: 'DELETE' }), 200);
        assert.equal(await listed(), false, 'the board is gone');
        console.log('   ✓');

        console.log('2. The page asks again (its Messages tab shown): it says the team was deleted, stops polling and the board stays gone');
        // The board's poll is one 10 s interval (board_poll.js). Record the 10 s intervals this page starts and the ones it clears, so "stops polling" is checked directly, not by waiting out several periods (#13016).
        await ev(`window.__polls = []; window.__cleared = new Set(); { const S = window.setInterval, C = window.clearInterval;
            window.setInterval = (fn, ms, ...a) => { const id = S(fn, ms, ...a); if (ms === 10000) window.__polls.push(id); return id; };
            window.clearInterval = id => { window.__cleared.add(id); return C(id); }; }
            window.__after = []; { const R = window.fetch; window.fetch = (u, o) => { if (String(u).includes(${JSON.stringify(api)})) window.__after.push((o && o.method || 'GET') + ' ' + String(u)); return R(u, o); }; }
            import((window.__coralStatic || '/static/') + 'message_board.js').then(m => m.showBoardInPage(${JSON.stringify(B)}, document.getElementById('mb-board').parentElement)).then(() => true)`);
        await waitFor(`(document.getElementById('mb-messages') || {}).textContent === 'This team was deleted.'`, 'the deleted-team words', 8000).catch(async e => { throw new Error(`${e.message}; the messages box held: ${JSON.stringify(String(await ev(`(document.getElementById('mb-messages') || {}).textContent`)).slice(0, 200))}`); });
        const seen = await ev(`window.__after.length`);
        await new Promise(r => setTimeout(r, 1500)); // sleep-ok: node-side wait to see that nothing more goes out
        assert.equal(await ev(`window.__after.filter(x => x.startsWith('POST') || x.startsWith('PUT')).length`), 1, 'one subscribe was sent and refused; no write after it');
        assert.ok((await ev(`window.__after.length`)) - seen <= 2, 'and the page is not polling the board');
        assert.ok((await ev(`window.__polls.length`)) >= 1, 'showing the board started its 10 s poll');
        assert.equal(await ev(`window.__polls.every(id => window.__cleared.has(id))`), true, 'and the page cleared every 10 s interval it started: the deleted-team page does not poll (#13016)');
        assert.equal(await listed(), false, 'nothing started the board again');
        console.log('   ✓');

        console.log('3. An agent joins a board of the same name on purpose: it works, and then so does the Operator');
        assert.equal(await call('/subscribe', J, { subscriber_id: 'qa', job_title: 'QA Engineer' }), 200);
        assert.equal(await listed(), true, 'the board is back, started by the join');
        assert.equal(await call('/subscribe', J, { subscriber_id: 'Operator', job_title: 'Operator' }), 200);
        console.log('   ✓');
    } finally { await removeBoards(ev, [B]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
