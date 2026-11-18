// Stop agent on a team agent archives it (#19674, the Operator's three states): the row menu has no separate Archive item; Stop agent, after its confirmation, calls the archive route (the session ends, the seat stays)
// and never the kill route. The confirmation says so in words. The team page's live agents are seeded; the calls are stubbed. 1280 px, through the real sidebar.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-stop-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM);
        const sid = await ev(`(window.__LIVE.find(s => s.name === 'Backend Dev') || {}).session_id`);
        assert.ok(sid && await ev(`!!window.__LIVE.find(s => s.session_id === ${JSON.stringify(sid)}).board_project`), 'the seeded Backend Dev is a team agent');
        await ev(`(() => { window.__calls = []; const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (o.method === 'POST' && /^\\/api\\/sessions\\/live\\/[^/]+\\/(archive|kill)$/.test(url.pathname)) { window.__calls.push(url.pathname.split('/').pop()); return Promise.resolve(new Response(JSON.stringify({ ok: true, sleeping: true, archived: true }), { status: 200, headers: { 'content-type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM); await settle(500);
        const row = `document.querySelector('#live-sessions-list [data-on-click="session-open"][data-session-id="${sid}"]')`;
        await waitFor(`!!${row}`, 'the agent row', 8000);
        await ev(`${row}.querySelector('[data-on-click="kebab-toggle"]').click(); true`);
        await waitFor(`!!document.querySelector('#live-sessions-list [data-on-click="agent-kill"][data-session-id="${sid}"]')`, 'the Stop agent item', 8000);
        const items = await ev(`[...document.querySelectorAll('#live-sessions-list [data-session-id="${sid}"].overflow-menu-item, #live-sessions-list .overflow-menu-item[data-session-id="${sid}"]')].map(e => e.textContent.trim().replace(/\\s+/g, ' '))`);
        assert.ok(items.includes('Stop agent') && !items.includes('Archive'), 'the menu has Stop agent and no separate Archive: ' + JSON.stringify(items));
        await ev(`document.querySelector('#live-sessions-list [data-on-click="agent-kill"][data-session-id="${sid}"]').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the confirmation', 8000);
        const said = await ev(`document.getElementById('confirm-modal-message').textContent.replace(/\\s+/g, ' ')`);
        assert.match(said, /archives it/, 'the confirmation says it archives: ' + said);
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`window.__calls.length === 1`, 'one call', 8000);
        assert.deepEqual(await ev('window.__calls'), ['archive'], 'Stop on a team agent is the archive call, not the kill call');
        console.log('PASS Stop agent on a team agent archives it: no Archive item, the confirmation says so, one archive call and no kill');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
