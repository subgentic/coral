// The Needs you count moves with the rows it counts (#18067, v2.0.69 trial: goal_closed_row read the count after the row was drawn and before the goals read ended). A goal the person made and an agent closed is a row and a count
// from the same read: here the settings read that ends the goals read is held for 3 s, and when the row is there the count is already up by one. Real server, a real goal closed through the close route as an agent.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'gcc-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const openNeeds = () => ev(`localStorage.setItem('coral-inbox-group-mode','none'); window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const f = window.fetch.bind(window); window.fetch = (u, o) => (window.__slowSettings && String(u).startsWith('/api/settings') && (!o || !o.method || o.method === 'GET')) ? new Promise(r => setTimeout(r, 3000)).then(() => f(u, o)) : f(u, o); })();` }); // sleep-ok: the settings read is held on purpose, so the goals read is known to be unfinished while the row is drawn
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: B })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Closed by the agent', outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201);
        assert.ok((await api('PATCH', `/api/board/${B}/goals/${g.body.id}`, { subscriber_id: 'Operator', state: 'active' })).status < 300);
        assert.equal((await api('POST', `/api/board/${B}/goals/${g.body.id}/close`, { subscriber_id: 'orch', state: 'done', reason: 'Code read through' })).status, 200);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const baseline = await ev(`import(${S} + 'inbox_tab.js').then(m => m.inboxCountsNow().needs)`);
        await ev(`window.__slowSettings = true; true`);
        await openNeeds();
        await waitFor(`[...document.querySelectorAll('#group-table-view .nl-title')].some(e => e.textContent.includes('Goal #${g.body.id} closed as done by orch'))`, 'the agent-closed goal has its row', 20000);
        const at = await ev(`import(${S} + 'inbox_tab.js').then(m => m.inboxCountsNow().needs)`);
        assert.equal(at, baseline + 1, 'the count is up by one when the row is there, not 3 s later');
        console.log('PASS the count of a goal an agent closed arrives with its row');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
