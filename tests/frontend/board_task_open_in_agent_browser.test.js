// #10685 (OPERATOR): "Open task #N" on a board message inside an agent's view (the dock's Board tab) navigated away to the team's task page with no way back. It opens the task in the side preview beside the agent, as the dock's own tasks
// do (#8838): the agent stays selected and its address does not change, the team page is not opened, the task is in the shared preview pane, and closing it leaves the agent as it was. At 1280 and 390. A real board.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const B = 'task-in-agent-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator' })).status, 200);
        const t = await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'Boss', title: 'Check the panel', body: 'A task a message names', priority: 'medium', assigned_to: 'Boss' });
        assert.equal(t.status, 201, JSON.stringify(t)); const id = t.body.id || t.body.task.id;
        assert.equal((await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'Boss', content: `See the panel task #${id} when you can.` })).status, 200);
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.__m.add('bt-agent', 'B', 1, { sleeping: false, board_project: ${JSON.stringify(B)} }); true`);
            await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'bt-agent')`, at + 'the agent on the board', 8000);
            await ev(`window.selectLiveSession('bt-agent', 'claude', 'bt-agent-id', 'local'); true`);
            await ev(`(() => { const d = document.getElementById('agentic-state'); if (d.getBoundingClientRect().width < 50 || d.classList.contains('collapsed')) { const b = document.getElementById('panel-toggle-btn') || document.getElementById('popout-panel-toggle-btn'); if (b) b.click(); } const t = document.getElementById('agentic-tab-board'); if (t) t.click(); return true; })()`);
            await waitFor(`document.querySelectorAll('#board-panel-msgs > .mb-message').length >= 1`, at + 'the board message in the agent view', 15000);
            const before = await ev(`({ path: location.pathname, session: T.state.currentSession && T.state.currentSession.session_id, nav: document.body.getAttribute('data-nav-tab') })`);
            await ev(`document.querySelector('#board-panel-msgs > .mb-message .mb-row-toggle').click(); true`);
            await waitFor(`!!document.querySelector('#board-panel-msgs .mb-task-link')`, at + 'the Open task button', 5000);
            await ev(`document.querySelector('#board-panel-msgs .mb-task-link').click(); true`);
            await waitFor(`!!document.querySelector('#preview-pane .team-task-page')`, at + 'the task in the side preview', 10000);
            const after = await ev(`({ path: location.pathname, session: T.state.currentSession && T.state.currentSession.session_id, nav: document.body.getAttribute('data-nav-tab'), teamPage: !!document.querySelector('#team-page') && document.querySelector('#team-page').getClientRects().length > 0, board: !!document.querySelector('#board-panel-msgs') })`);
            assert.deepEqual({ path: after.path, session: after.session, nav: after.nav }, before, at + 'the agent stays: same address, same session, same tab of the page');
            assert.ok(!after.teamPage && after.board, at + 'the team page was not opened and the agent\'s Board tab is still there: ' + JSON.stringify(after));
            assert.ok(await ev(`[...document.querySelectorAll('#preview-pane .preview-tab')].some(e => e.textContent.includes('Task ${id}') || e.textContent.includes('Check the panel'))`), at + 'the task has a tab in the shared preview pane');
            await waitFor(`document.querySelector('#preview-pane .team-task-page').textContent.includes('Check the panel')`, at + 'the task\'s own page in the pane', 10000);
            await ev(mobile ? `document.getElementById('preview-full-back').click(); true` : `document.querySelector('#preview-pane .preview-tab-close').click(); true`);
            assert.equal(await ev(`location.pathname`), before.path, at + 'closing the preview leaves the agent where it was');
        }
        console.log('\nPASS Open task on a board message opens beside the agent');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
