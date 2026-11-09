// #14955 (v2.0.61 blocker, goal_operator_dialogs 'More opens' timing out): the goal header's More button opens a menu whose code loads on first use. A tap that came while that code was loading, with the
// page drawn again meanwhile (the goal's tasks arriving), went to a button that was no longer on the page: nothing opened. The suite holds the menu code's request, taps More on a phone, draws the page
// again, lets the code arrive and wants the menu open on the button that is on the page now.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { safePaused } = require('./helpers/paused');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 900, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        const board = `goal-more-tap-${Date.now().toString(36)}`; boards.push(board);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board + 'orch' })).status, 200);
        const g = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Operator', title: 'Tap More once', outcome: 'It opens', done_when: 'The menu is open', driver: 'orch' });
        assert.equal(g.status, 201, JSON.stringify(g.body)); const id = g.body.id;
        await Page.navigate({ url: BASE + `/inbox/goals/${board}/${id}` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await waitFor(`!!document.querySelector('#inbox-page .goal-head-actions .task-more-btn')`, 'the goal page has More', 15000);

        // hold the menu code's request from here on (a page that already has the code, or built the button before this, is not held: that is the fixed shape)
        const held = [];
        await client.Fetch.enable({ patterns: [{ urlPattern: '*menu_button*', requestStage: 'Request' }] });
        safePaused(client, p => { held.push(p.requestId); });
        const loaded = await ev(`typeof window.__coral === 'object' && performance.getEntriesByType('resource').some(r => /menu_button/.test(r.name))`);
        await ev(`window.__b1 = document.querySelector('#inbox-page .goal-head-actions .task-more-btn'); window.__b1.click(); true`);
        // the page is drawn again while the tap waits for the code (when the code is already loaded the tap has nothing to wait for: it opens the menu at once, which is the fixed shape)
        if (!loaded) assert.equal((await api('PATCH', `/api/board/${board}/goals/${id}`, { subscriber_id: 'Operator', outcome: 'It opens, said again' })).status, 200);
        if (!loaded) await ev(`window.dispatchEvent(new Event('focus')); new Promise(r => setTimeout(r, 700))`); // sleep-ok: the page's refresh reads the goal and draws it again while the held code is still on its way
        for (const requestId of held.splice(0)) await client.Fetch.continueRequest({ requestId });
        await client.Fetch.disable();
        await waitFor(`!!document.querySelector('#inbox-page .goal-head-actions .task-more-menu') && !document.querySelector('#inbox-page .goal-head-actions .task-more-menu').hidden`, `More is open on the button that is on the page (code already loaded: ${loaded})`, 5000);
        assert.equal(await ev(`document.querySelector('#inbox-page .goal-head-actions .task-more-btn').getAttribute('aria-expanded')`), 'true');
        console.log('PASS goal header: a More tap that waited for the menu code still opens the menu after the page was drawn again');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
