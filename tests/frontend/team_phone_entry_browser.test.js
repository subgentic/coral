// Inside a team on a phone (#15163, Beta walk 6 H5): the bar's arrow goes back to where the person came from (the Inbox's Needs you), not always to Agents. 390 px, a real board.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [], problems = [], S = `(window.__coralStatic || '/static/')`;
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const board = 'team-entry-' + Date.now().toString(36); boards.push(board);
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
        const g = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Operator', title: 'A goal', outcome: 'One goal', done_when: 'Done' }); assert.equal(g.status, 201);
        assert.equal((await api('PATCH', `/api/board/${board}/goals/${g.body.id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        // the person is in the Inbox's Needs you, then goes into the team on its Board tab (the far right of the strip)
        await ev(`import(${S} + 'nav.js').then(async n => { const r = await import(${S} + 'routes.js'); await n.go(r.parse('/inbox/needs')); await n.go(r.parse('/team/${board}/messages')); return true; })`);
        await waitFor(`!!document.getElementById('team-tabs') && document.getElementById('team-tabs').getClientRects().length > 0 && document.getElementById('team-tab-messages').getAttribute('aria-selected') === 'true'`, 'the team page on Board', 15000);
        // the bar's arrow goes back to where the person came from
        await ev(`document.getElementById('team-page-bar-back').click(); true`);
        await waitFor(`location.pathname === '/inbox/needs'`, 'the arrow goes back to the Inbox the person came from', 8000).catch(() => {});
        const path = await ev(`location.pathname`);
        if (path !== '/inbox/needs') problems.push('the bar arrow went to ' + path + ', not back to /inbox/needs');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('team_phone_entry_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
