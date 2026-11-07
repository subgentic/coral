// The Inbox is kept current without the 30 s age tick (#13389, #9551 "never polled"): a goal that finishes while Needs you is open appears with the next live update, not on a reload. A live update is what
// api.js does after each list of sessions (updateInboxTab); the goals are then read again at most every 30 s (here 1 ms: __coralGoalsMs), and not in a hidden tab. Real board and settings routes on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, settle } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const B = 'live-goal-' + Date.now().toString(36);

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const root = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const T = '#group-table-view';
    const doneRows = () => ev(`[...document.querySelectorAll('${T} tbody tr')].filter(tr => /looks done/.test(tr.textContent)).length`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await client.Emulation.setFocusEmulationEnabled({ enabled: true }); // a visible page: the live goals read is for a tab that is on screen
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
        await root('PUT', '/api/settings', { goal_done_hidden: '[]', goal_done_read: '[]', goal_done_quiet_minutes: '0' });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); // the page reads the quiet period (0) at start: a goal that just finished is then an item at once
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await settle(ev, 600, 300);
        assert.equal(await doneRows(), 0, 'nothing is done yet');
        await ev(`window.__noReload = 'same page'; globalThis.__coralGoalsMs = 1; true`);

        // a goal finishes while the Inbox is open
        const g = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Finished meanwhile', done_when: 'it is done' }); assert.equal(g.status, 201);
        const gid = g.json.id || g.json.goal.id;
        const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); const tid = t.json.id || t.json.task.id;
        assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid })).status < 300);
        assert.ok((await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);

        // a live update (what api.js does after each list of sessions) brings it in, with no reload and no timer
        let seen = 0;
        for (let i = 0; i < 40 && !seen; i++) { await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => { m.updateInboxTab(); return true; })`); await new Promise(r => setTimeout(r, 500)); seen = await doneRows(); } // sleep-ok: the read behind the live update is a request with no event to wait for
        assert.equal(seen, 1, 'the goal that finished while the Inbox was open is a row of Needs you after a live update');
        assert.equal(await ev(`window.__noReload`), 'same page', 'on the same page: no reload');
        console.log('\nPASS a goal that finishes while the Inbox is open appears with the next live update, no reload, no tick');
    } finally { await guard.restore().catch(() => {}); await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
