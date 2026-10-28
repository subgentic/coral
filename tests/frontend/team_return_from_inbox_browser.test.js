// The Agents tab, chosen again from the Inbox (or any other tab), is the team page that was on screen, not Home (Beta Tester's pass, #10008): leaving the team page for another tab left the team as the selected one, but the tab then drew
// Home (the welcome screen). Now it opens the team's page again, on the tab it was on. With no team open, Agents is Home as before, and a session opened from the list is not the team. At 1280 and 390 px; the isolated dev server, a
// board made through the API.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const BOARD = 'return-team-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shown = id => `(() => { const e = document.getElementById('${id}'); return !!e && e.getClientRects().length > 0; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            // Agents with no team open is Home, as before
            await ev(`window.switchNavTab('hub-inbox'); window.switchNavTab('agents'); true`); await new Promise(r => setTimeout(r, 500)); // sleep-ok: the tab draws
            check(!(await ev(shown('team-page-view'))), 'with no team open the Agents tab is not a team page');
            // open a team's page, on its Tasks tab, then the Inbox, then Agents again
            await ev(`window.openTeamPage(${JSON.stringify(BOARD)}, { tab: 'tasks' }).then(() => true)`);
            await waitFor(`${shown('team-page-view')} && document.getElementById('team-page-title').textContent.includes('return-team')`, `${w}: the team page`, 15000);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.body.getAttribute('data-nav-tab') === 'hub-inbox' && !${shown('team-page-view')}`, `${w}: the Inbox`, 10000);
            await ev(`window.switchNavTab('agents'); true`);
            await waitFor(`${shown('team-page-view')}`, `${w}: the team page again`, 10000).catch(() => check(false, 'the Agents tab from the Inbox is the team page that was on screen, not Home'));
            check(await ev(`document.getElementById('team-page-title') && document.getElementById('team-page-title').textContent.includes('return-team')`), 'and it is that team');
            check(await ev(`(document.querySelector('#team-page-view [role=tab][aria-selected=true]') || {}).id === 'team-tab-tasks'`), 'on the tab it was on (Tasks)');
            // a session opened from the list is not the team: after it, Agents is that session, not the team
            await ev(`window.exitTeamPage && window.exitTeamPage({ force: true }); window.switchNavTab('agents'); true`); await new Promise(r => setTimeout(r, 500)); // sleep-ok: the tab draws
            check(!(await ev(shown('team-page-view'))), 'after leaving the team for good the Agents tab is Home');
        }
    } finally { await removeBoards(ev, [BOARD]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the way back to a team:\n  ' + problems.join('\n  '));
    console.log('PASS the Agents tab from the Inbox is the last team');
})().catch(e => { console.error(e); process.exit(1); });
