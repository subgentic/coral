// The team's Tasks tab, empty, says what to do next (#10371, Beta #10367: "No tasks yet" had no next step): "No tasks yet. Add one with New task, or tell the Orchestrator what you want." while the team has an
// Orchestrator, "No tasks yet. Add one with New task." when it has none. A team with no task is a fresh one on the isolated server. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, post, openTeam, goTab } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-empty-tasks-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        const live = names => ev(`(() => { window.__m.agents = {}; for (const [i, n] of ${JSON.stringify(names)}.entries()) window.__m.add(n, 'A', 1, { sleeping: false, session_id: 'sid-' + (i + 1), board_project: ${JSON.stringify(TEAM)} }); window.__LIVE = Object.values(window.__m.agents).map(x => window.__m.entry(x)); T.state.liveSessions = window.__LIVE; T.render.renderLiveSessions(window.__LIVE); return true; })()`);
        await live(['Backend Dev']); // a fresh team: its board exists, one agent and no task in it
        await post(ev, `/api/board/${TEAM}/subscribe`, { subscriber_id: 'Operator', job_title: 'Operator' });
        await openTeam(ev, waitFor, TEAM);
        const line = () => ev(`([...window.__tp.page().querySelectorAll('.empty-state-line')].map(e => e.textContent.trim()).find(t => /^No tasks yet/.test(t))) || ''`);
        await goTab(ev, settle, 'Tasks');
        await waitFor(`[...window.__tp.page().querySelectorAll('.empty-state-line')].some(e => /^No tasks yet/.test(e.textContent))`, 'the empty Tasks tab', 8000);
        assert.equal(await line(), 'No tasks yet. Add one with New task.', 'no Orchestrator in the team: only New task: ' + await ev(`JSON.stringify({ tabs: window.__tp.tabs().map(t => t.getAttribute('aria-selected') + ':' + window.__tp.tabLabel(t)), lines: [...window.__tp.page().querySelectorAll('.empty-state-line')].map(e => e.textContent) })`));
        await live(['Orchestrator', 'Backend Dev']);
        await goTab(ev, settle, 'Goals'); await goTab(ev, settle, 'Tasks');
        await waitFor(`[...window.__tp.page().querySelectorAll('.empty-state-line')].some(e => /Orchestrator/.test(e.textContent))`, 'the line naming the Orchestrator', 8000);
        assert.equal(await line(), 'No tasks yet. Add one with New task, or tell the Orchestrator what you want.', 'with an Orchestrator the line says so too');
        console.log('PASS the empty Tasks tab says what to do next');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
