// #16633: the top Inbox tab, chosen while the Inbox shows one of its pages (a goal), goes back to the Inbox's list (Needs you), as the sidebar's Needs you does; it used to do nothing.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = 'inbox-tab-' + Date.now().toString(36);
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({status:r.status,body:await r.json()}))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await load('/');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
        const created = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Operator', title: 'Tab goal', outcome: 'x', done_when: 'y' });
        assert.equal(created.status, 201); const id = created.body.id;
        assert.equal((await api('PATCH', `/api/board/${board}/goals/${id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        await load(`/inbox/goals/${board}/${id}`);
        await waitFor(`!!document.querySelector('#inbox-page #goals-detail-title')`, 'the goal page in the Inbox', 15000);
        await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
        await waitFor(`document.getElementById('inbox-page')?.hidden === true `, 'the Inbox tab leaves the goal page for the Inbox list', 8000);
        assert.equal(await ev(`document.querySelector('.view-list-item[aria-current="true"]')?.dataset.key`), 'needs', 'it lands on Needs you');
        console.log('inbox_tab_leaves_page_browser: ok');
    } finally { try { await removeBoards(ev, [board]); } catch (e) {} await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
