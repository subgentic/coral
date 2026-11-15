// #16663 (QA/Security INFO on #15833): a phone's Inbox Goals list draws its first rows only after data_table_goals.css (the shared goal-card rules, lazy) has loaded, so the old card never shows for a frame.
// The stylesheet's request is held: while it is held no goal row is on the page; once released the rows come, with the new card's rules applied (the number stays with a two-line title).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [], problems = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const held = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const board = 'goals-css-' + Date.now().toString(36); boards.push(board);
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
        const g = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Operator', title: 'A goal whose title is long enough to run onto a second line on a phone screen', outcome: 'One goal', done_when: 'A person chooses' }); assert.equal(g.status, 201);
        assert.equal((await api('PATCH', `/api/board/${board}/goals/${g.body.id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        await client.Fetch.enable({ patterns: [{ urlPattern: '*data_table_goals.css*', requestStage: 'Request' }] });
        client.on('Fetch.requestPaused', p => held.push(p.requestId));
        await Page.navigate({ url: BASE + '/inbox/goals' });
        await new Promise(r => setTimeout(r, 2500)); // sleep-ok: nothing may be drawn while the stylesheet is held; the wait is the thing under test
        const early = await ev(`document.querySelectorAll('#inbox-page tbody tr, #group-table-view tbody tr').length`);
        if (!held.length) problems.push('the stylesheet was never requested while the Inbox Goals list was opening');
        if (early) problems.push(`${early} goal row(s) were drawn while data_table_goals.css was still loading (the old card shows for a frame)`);
        await client.Fetch.disable();
        for (const id of held) await client.Fetch.continueRequest({ requestId: id }).catch(() => {});
        await waitFor(`document.querySelectorAll('#inbox-page tbody tr, #group-table-view tbody tr').length >= 1`, 'the goal rows after the stylesheet', 20000);
        await ev(framesJs(4));
    } finally { await client.Fetch.disable().catch(() => {}); await removeBoards(ev, boards).catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('inbox_goals_css_first_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
