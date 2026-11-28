// #15257 (Beta walk 12 H1): a goal an agent closed as done is a row of Needs you, "Goal #N closed as done by <agent>", with Reopen and Dismiss. It is listed AND counted (#16753, the Operator): the Needs you count and the Inbox badge go up by one for each goal the person made that an agent closed. Reopen puts the goal
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
    const openNeeds = () => ev(`localStorage.setItem('coral-inbox-group-mode','none'); window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
    const needsCount = () => ev(`import(${S} + 'inbox_tab.js').then(m => m.inboxCountsNow().needs)`);
    const countIs = n => waitFor(`import(${S} + 'inbox_tab.js').then(m => m.inboxCountsNow().needs === ${n})`, `the count is ${n}`, 15000).catch(() => {}); // the rows come from the goals read, the count from the counts read: wait for the count, then assert it (#17540)
    const rowTitles = () => ev(`[...document.querySelectorAll('#group-table-view .nl-title')].map(e => e.textContent)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`true`);
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: B })).status < 300);
        await openNeeds(); await new Promise(r => setTimeout(r, 1500)); // sleep-ok: lets the Needs-you count settle before it is read as the baseline; no event marks it
        const baseline = await needsCount(), baselineBadge = await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`); // the count before any goal is closed
        const mk = async title => { const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title, outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201); assert.equal((await api('PATCH', `/api/board/${B}/goals/${g.body.id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200); return g.body.id; };
        const a = await mk('Closed by the agent'), b = await mk('Closed by the person'), c = await mk('Closed by the agent too');
        assert.equal((await api('POST', `/api/board/${B}/goals/${a}/close`, { subscriber_id: 'orch', state: 'done', reason: 'Code read through' })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/goals/${b}/close`, { subscriber_id: 'Operator', state: 'done', reason: 'Looks right' })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/goals/${c}/close`, { subscriber_id: 'orch', state: 'done', reason: 'All tasks done' })).status, 200);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); // a fresh page: it reads the closed goals again
        await openNeeds();
        await waitFor(`[...document.querySelectorAll('#group-table-view .nl-title')].some(e => e.textContent.includes('Goal #${a} closed as done by orch'))`, 'the agent-closed goal has its row', 15000);
        const titles = await rowTitles();
        assert.ok(titles.some(t => t.includes(`Goal #${c} closed as done by orch`)), 'the second agent-closed goal too: ' + JSON.stringify(titles));
        assert.ok(!titles.some(t => t.includes(`Goal #${b} `)), 'a goal the Operator closed has no row: ' + JSON.stringify(titles));
        await waitFor(`!!document.getElementById('nav-tab-hub-inbox-badge')`, 'the badge', 5000);
        await waitFor(`import(${S} + 'inbox_tab.js').then(m => m.inboxCountsNow().needs === ${baseline + 2})`, 'the count follows the rows (the rows and the count are two reads)', 15000).catch(() => {}); // the rows are drawn from the goals read, the count from the counts read: wait for it, then assert it
        assert.equal(await needsCount(), baseline + 2, 'counted (#16753): two goals the person made, closed by an agent, add two (the one the Operator closed adds nothing)');
        assert.equal(Number(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`) || 0), Number(baselineBadge || 0) + 2, 'the Inbox badge moves with it');
        const press = (goal, label) => ev(`(() => { const tr = [...document.querySelectorAll('#group-table-view .nl-row')].find(r => r.textContent.includes('Goal #${goal} closed as done')); const btn = tr && [...tr.querySelectorAll('button')].find(x => x.textContent === ${JSON.stringify(label)}); if (btn) btn.click(); return !!btn; })()`);
        assert.ok(await press(a, 'Reopen'), 'Reopen is on the row');
        await waitFor(`![...document.querySelectorAll('#group-table-view .nl-title')].some(e => e.textContent.includes('Goal #${a} closed as done'))`, 'Reopen takes the row away', 10000);
        assert.equal((await api('GET', `/api/board/${B}/goals/${a}`)).body.state, 'active', 'the goal is active again');
        await countIs(baseline + 1);
        assert.equal(await needsCount(), baseline + 1, 'Reopen takes its count away');
        assert.ok(await press(c, 'Dismiss'), 'Dismiss is on the row');
        await waitFor(`![...document.querySelectorAll('#group-table-view .nl-title')].some(e => e.textContent.includes('Goal #${c} closed as done'))`, 'Dismiss takes the row away', 10000);
        assert.equal((await api('GET', `/api/board/${B}/goals/${c}`)).body.state, 'done', 'dismissed, not reopened');
        await countIs(baseline);
        assert.equal(await needsCount(), baseline, 'Dismiss takes its count away');
        console.log('PASS a goal an agent closed has a listed, counted row with Reopen and Dismiss');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
