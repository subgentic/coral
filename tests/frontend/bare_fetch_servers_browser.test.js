// Calls on a computer's data go to that computer (#12617, the census is bare_api_fetch_census): through Coral Hub a bare /api path is the Hub's own. The star on a file of another computer, a session's history read for a board export, and the
// keep, star and delete of the team page's Artifacts list are asked on the computer the data is from (/api/remote/<id>/api/...), and this computer's keep its plain path. A real isolated server serves the page; the calls are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const HEX = 'ab'.repeat(32);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`window.__calls = []; const orig = window.fetch.bind(window); window.fetch = (u, o) => { const url = String(u); if (/\\/star$|\\/history\\//.test(url)) { window.__calls.push(((o && o.method) || 'GET') + ' ' + url.replace(/\\?.*/, '')); return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return orig(u, o); }; true`);

        // the star on a row of the Inbox's Artifacts: the computer the row is on
        await ev(`(async () => { const m = await import(${S} + 'artifact_star.js'); for (const item of [{ server: 'box-1', starred: false }, { starred: false }, { board_id: '@box-2/team', starred: false }]) { const b = m.starControl(item, { hex: '${HEX}', name: 'a file' }); document.body.append(b); b.click(); await new Promise(r => setTimeout(r, 50)); } return true; })()`); // sleep-ok: three clicks, one after the other, the stub answers at once
        const stars = await ev(`window.__calls.filter(c => /star/.test(c))`);
        assert.deepEqual(stars, [`PUT /api/remote/box-1/api/artifacts/${HEX}/star`, `PUT /api/artifacts/${HEX}/star`, `PUT /api/remote/box-2/api/artifacts/${HEX}/star`], 'a star goes to the computer the row is on: ' + JSON.stringify(stars));

        // a session's history for a board export: the board's computer
        await ev(`window.__calls = []; (async () => { const m = await import(${S} + 'board_fetch.js'); await m.fetchAllHistory('sess-1', 'box-1'); await m.fetchAllHistory('sess-2'); return true; })()`);
        const hist = await ev(`window.__calls`);
        assert.ok(hist[0].startsWith('GET /api/remote/box-1/api/sessions/history/sess-1') && hist[1].startsWith('GET /api/sessions/history/sess-2'), 'the history is read on the board\'s computer: ' + JSON.stringify(hist));
    } finally { await client.close(); }
    console.log('bare_fetch_servers_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
