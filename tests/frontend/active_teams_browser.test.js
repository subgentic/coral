// The agent list shows the active teams, and Show all teams brings back the rest (#15744, the Operator via coral-hub: leftover test boards filled the phone drawer). A team is active when one of its agents
// is awake or has a message waiting; they go newest message first; the idle ones are one row away, "Show all teams (n idle)", remembered in this browser; the open team and a searched-for team are listed
// even when idle; with four teams or fewer nothing is hidden. Drawn from state.liveSessions at 390 px (the phone's drawer) and at 1440, on an isolated dev server; run_cdp_suites finds it by name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const S = (id, team, extra) => ({ session_id: id, name: id, agent_type: 'claude', working_directory: '/tmp/' + team, board_project: team, display_name: id, sleeping: false, ...extra });
const asleep = (id, team, extra) => S(id, team, { sleeping: true, ...extra });
// three active teams (an awake agent; only sleeping agents but a message waiting; an awake agent with an older message), five idle ones
const SESSIONS = [
    asleep('cli-msg-1', 'cli-msg-1'), asleep('cli-msg-2', 'cli-msg-2'), asleep('orch-notify-1', 'orch-notify-1'), asleep('orch-notify-2', 'orch-notify-2'), asleep('old-board', 'old-board'),
    S('a1', 'alpha', { last_message: { role: 'agent', text: 'x', at: '2026-11-11T10:00:00Z' } }),
    asleep('b1', 'beta', { board_unread: 3, last_message: { role: 'agent', text: 'y', at: '2026-11-11T12:00:00Z' } }),
    S('c1', 'gamma', { last_message: { role: 'agent', text: 'z', at: '2026-11-10T09:00:00Z' } }),
];
const IDLE = ['cli-msg-1', 'cli-msg-2', 'orch-notify-1', 'orch-notify-2', 'old-board'];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const NAMES = `[...new Set([...document.querySelectorAll('li.session-team-group > .session-group-header')].map(h => h.dataset.groupName))]`;
    const ROW = `(document.querySelector('li.teams-show-all button') || {}).textContent || ''`;
    const draw = sessions => ev(`window._coralSetLiveSessions(${JSON.stringify(sessions)}); true`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[390, true], [1440, false]]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            const at = `${width}px: `;
            await ev(`(() => { localStorage.removeItem('coral-teams-show-all'); localStorage.removeItem('coral-group-by-team'); localStorage.removeItem('coral_collapsed_groups'); window.switchNavTab('agents'); return true; })()`);
            await draw(SESSIONS);
            await waitFor(`document.querySelectorAll('li.session-team-group').length >= 3`, at + 'the team cards', 10000);
            await waitFor(`${ROW}.length > 0`, at + 'the Show all teams row (the module loads, then the list is drawn again)', 10000);
            assert.deepEqual(await ev(NAMES), ['beta', 'alpha', 'gamma'], at + 'only the active teams, the newest message first');
            assert.equal(await ev(ROW), 'Show all teams (5 idle)', at + 'the row says how many are left out');
            assert.equal(await ev(`document.querySelector('li.teams-show-all button').getAttribute('aria-expanded')`), 'false');
            // open team: listed even when idle
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.selectedTeam = 'old-board'; return window._coralSetLiveSessions(${JSON.stringify(SESSIONS)}); }).then(() => true)`);
            assert.ok((await ev(NAMES)).includes('old-board') && (await ev(NAMES)).length === 4, at + 'the open team stays listed: ' + JSON.stringify(await ev(NAMES)));
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.selectedTeam = ''; return true; })`);
            await draw(SESSIONS);
            // Show all teams
            await ev(`document.querySelector('li.teams-show-all button').click(); true`);
            await waitFor(`${ROW} === 'Show active teams only'`, at + 'every team after the click', 5000);
            assert.equal((await ev(NAMES)).length, 8, at + 'all eight teams: ' + JSON.stringify(await ev(NAMES)));
            assert.equal(await ev(`localStorage.getItem('coral-teams-show-all')`), 'true', at + 'remembered in this browser');
            // a reload keeps it, and "Show active teams only" undoes it
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.switchNavTab('agents'); true`); await draw(SESSIONS);
            await waitFor(`${ROW} === 'Show active teams only'`, at + 'the choice kept after a reload', 10000);
            await ev(`document.querySelector('li.teams-show-all button').click(); true`);
            await waitFor(`${ROW} === 'Show all teams (5 idle)'`, at + 'back to the active teams', 5000);
            assert.deepEqual(await ev(NAMES), ['beta', 'alpha', 'gamma']);
            // searching lists every team that matches, idle or not
            await ev(`(() => { const i = document.getElementById('agent-search-input'); i.value = 'cli-msg'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`(${NAMES}).includes('cli-msg-1')`, at + 'a searched-for idle team is listed', 5000);
            assert.equal(await ev(ROW), '', at + 'no Show all row while searching');
            // four teams or fewer: nothing hidden
            await ev(`(() => { const i = document.getElementById('agent-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await draw(SESSIONS.filter(s => ['cli-msg-1', 'alpha', 'beta', 'gamma'].includes(s.board_project)));
            assert.equal((await ev(NAMES)).length, 4, at + 'four teams are all listed');
            assert.equal(await ev(ROW), '', at + 'and no row');
            await ev(`localStorage.removeItem('coral-teams-show-all'); true`);
            console.log('PASS ' + at + 'active teams first, idle ones behind Show all teams, kept per browser, open and searched teams listed');
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
