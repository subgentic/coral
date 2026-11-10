// #15257 (Beta walk 12 H1): a goal an agent closed as done is a row of Needs you, "Goal #N closed as done by <agent>", with Reopen and Dismiss. It is listed, not counted: the Inbox badge does not move. Reopen puts the goal
// back to active (and the row goes); Dismiss hides it in this browser; a goal the Operator closed has no such row. Real server, a real goal closed through the close route as an agent and as the Operator.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'gcr-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const openNeeds = () => ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
    const rowTitles = () => ev(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].map(e => e.textContent)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`true`);
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: B })).status < 300);
        const mk = async title => { const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title, outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201); assert.equal((await api('PATCH', `/api/board/${B}/goals/${g.body.id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200); return g.body.id; };
        const a = await mk('Closed by the agent'), b = await mk('Closed by the person'), c = await mk('Closed by the agent too');
        assert.equal((await api('POST', `/api/board/${B}/goals/${a}/close`, { subscriber_id: 'orch', state: 'done', reason: 'Code read through' })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/goals/${b}/close`, { subscriber_id: 'Operator', state: 'done', reason: 'Looks right' })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/goals/${c}/close`, { subscriber_id: 'orch', state: 'done', reason: 'All tasks done' })).status, 200);
        await openNeeds();
        await waitFor(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(e => e.textContent.includes('Goal #${a} closed as done by orch'))`, 'the agent-closed goal has its row', 15000);
        const titles = await rowTitles();
        assert.ok(titles.some(t => t.includes(`Goal #${c} closed as done by orch`)), 'the second agent-closed goal too: ' + JSON.stringify(titles));
        assert.ok(!titles.some(t => t.includes(`Goal #${b} `)), 'a goal the Operator closed has no row: ' + JSON.stringify(titles));
        assert.ok(await ev(`document.getElementById('nav-tab-hub-inbox-badge').hidden || !/goal/i.test(document.getElementById('nav-tab-hub-inbox-badge').title || '')`), 'listed, not counted');
        const press = (goal, label) => ev(`(() => { const tr = [...document.querySelectorAll('#group-table-view tr')].find(r => r.textContent.includes('Goal #${goal} closed as done')); const btn = tr && [...tr.querySelectorAll('button')].find(x => x.textContent === ${JSON.stringify(label)}); if (btn) btn.click(); return !!btn; })()`);
        assert.ok(await press(a, 'Reopen'), 'Reopen is on the row');
        await waitFor(`![...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(e => e.textContent.includes('Goal #${a} closed as done'))`, 'Reopen takes the row away', 10000);
        assert.equal((await api('GET', `/api/board/${B}/goals/${a}`)).body.state, 'active', 'the goal is active again');
        assert.ok(await press(c, 'Dismiss'), 'Dismiss is on the row');
        await waitFor(`![...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(e => e.textContent.includes('Goal #${c} closed as done'))`, 'Dismiss takes the row away', 10000);
        assert.equal((await api('GET', `/api/board/${B}/goals/${c}`)).body.state, 'done', 'dismissed, not reopened');
        console.log('PASS a goal an agent closed has a listed, uncounted row with Reopen and Dismiss');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
