// Removing a team (#15277, walk 15): killing a team says so in a toast and says the team stays (Remove team is on its page); a team with no agent left (killed) is still called by its name on
// its page, not by its raw board id (the name came from its agents). Chrome over CDP against the isolated dev server with the harness's mocked live list; the board is real, the kill is scripted.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'trw-' + Date.now().toString(36);
    const NAME = 'Walk Timer';
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `window.__qaSeed = [{ name: 'tr-agent', prefix: 'A', n: 2, sleeping: false, board_project: ${JSON.stringify(B)}, session_id: 'tr-agent-id' }];
            { const R = window.fetch; window.fetch = (u, o) => { const s = String(u);
                if (o && o.method === 'POST' && /\\/api\\/sessions\\/live\\/team\\/[^/?]+\\/kill$/.test(s)) return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
                if (s === '/api/board/projects') return R(u, o).then(r => r.json()).then(rows => new Response(JSON.stringify((Array.isArray(rows) ? rows : []).map(p => p.project === ${JSON.stringify(B)} ? { ...p, board_label: ${JSON.stringify(NAME)} } : p)), { status: 200, headers: { 'content-type': 'application/json' } }));
                return R(u, o); }; }` });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        let l = Page.loadEventFired(); await Page.navigate({ url: BASE + '/' }); await l;
        await ev(`fetch('/api/board/${B}/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'qa', as: 'QA Engineer', content: 'a board to kill' }) }).then(r => r.status)`);
        l = Page.loadEventFired(); await Page.navigate({ url: `${BASE}/team/${B}/agents` }); await l;
        await install();
        await coralReady(ev);
        await ev(`Promise.resolve(window._coralLoadLiveSessions()).then(() => true)`);
        await waitFor(`(window.T.state.liveSessions || []).some(s => s.name === 'tr-agent')`, 'the running agent in the list', 15000);

        console.log('1. Kill team: a toast says it was stopped and that the team stays');
        await ev(`Promise.resolve(window.killBoard(${JSON.stringify(B)})).then(() => true)`);
        await waitFor(`!!document.getElementById('confirm-modal-yes') && document.getElementById('confirm-modal').getClientRects().length > 0`, 'the Kill team dialog', 6000);
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Stopped the 1 agent in .*The team stays; Remove team is on its page\\./.test(t.textContent))`, 'the toast', 8000);
        console.log('   ✓');

        console.log('2. The killed team has no agent: its page still has its name, not the raw board id');
        await waitFor(`!(window.T.state.liveSessions || []).some(s => s.name === 'tr-agent')`, 'the agent gone from the list', 6000);
        l = Page.loadEventFired(); await Page.navigate({ url: `${BASE}/team/${B}` }); await l;
        await coralReady(ev);
        await waitFor(`(document.getElementById('team-page-title') || {}).textContent === ${JSON.stringify(NAME)}`, `the page's title to be ${NAME}, not the raw id`, 10000);
        console.log('   ✓');
    } finally { await removeBoards(ev, [B]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
