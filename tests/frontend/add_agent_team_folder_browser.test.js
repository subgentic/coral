// Add agent's folder for a team (#11083, the Hub ask: "no folder yet"): (1) the team card's menu offers the first session of the team that HAS a working directory, not only the team's first row (a terminal, a finished or a stale row may have none);
// (2) a team with a home folder (#10815) prefills that folder, whatever its sessions say; (3) none anywhere: the dialog keeps its folder step. The home folder is stood in at GET /api/teams/detail/<team>. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const TEAM = 'ft-team';
    const dirOf = () => ev(`(() => { const b = [...document.querySelectorAll('button[data-on-click="team-add-agent"]')].find(x => x.dataset.board === ${JSON.stringify(TEAM)}); return b ? b.dataset.dir : null; })()`);
    const OPEN = `(() => { const m = document.getElementById('launch-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.__homeDir = ''; { const real = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (p.pathname === '/api/teams/detail/${TEAM}' && (o.method || 'GET') === 'GET') return Promise.resolve(window.__homeDir ? new Response(JSON.stringify({ name: '${TEAM}', working_dir: window.__homeDir }), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 })); return real(u, o); }; } true`);
        await ev(`window.__m.add('first-terminal', 'T', 1, { sleeping: false, session_id: 'ft1', board_project: ${JSON.stringify(TEAM)}, agent_type: 'terminal' }); window.__m.add('second-worker', 'W', 1, { sleeping: false, session_id: 'ft2', board_project: ${JSON.stringify(TEAM)} }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).filter(s => s.board_project === ${JSON.stringify(TEAM)}).length === 2`, 'the team', 10000);
        // (1) the team's first row has no working directory: the card offers the next one's
        await ev(`(async () => { const T = await import((window.__coralStatic || '/static/') + 'state.js'); const list = T.state.liveSessions, first = list.find(s => s.board_project === ${JSON.stringify(TEAM)}); first.working_directory = ''; const r = await import((window.__coralStatic || '/static/') + 'render.js'); r.renderLiveSessions(list); return true; })()`);
        await waitFor(`!![...document.querySelectorAll('button[data-on-click="team-add-agent"]')].find(x => x.dataset.board === ${JSON.stringify(TEAM)})`, 'the team card menu', 10000);
        assert.equal(await dirOf(), '/tmp/second-worker', "the team's first row has no folder: Add agent offers the first one that has");
        // (2) a home folder wins
        await ev(`window.__homeDir = '/work/home'; window.showAddAgentToBoard(${JSON.stringify(TEAM)}, '/tmp/second-worker'); true`);
        await waitFor(`${OPEN} && document.getElementById('launch-dir').value === '/work/home'`, 'the dialog with the home folder', 8000);
        assert.equal(await ev(`document.getElementById('launch-step-agent').dataset.stage`), 'persona', 'the folder is known: the dialog opens on the persona step');
        await ev(`window.hideLaunchModal(); true`);
        // (3) no home folder: the row's folder; none at all: the folder step
        await ev(`window.__homeDir = ''; window.showAddAgentToBoard(${JSON.stringify(TEAM)}, '/tmp/second-worker'); true`);
        await waitFor(`${OPEN} && document.getElementById('launch-dir').value === '/tmp/second-worker'`, 'the dialog with the session folder', 8000);
        await ev(`window.hideLaunchModal(); true`);
        await ev(`window.showAddAgentToBoard(${JSON.stringify(TEAM)}, ''); true`);
        await waitFor(`${OPEN} && document.getElementById('launch-step-agent').dataset.stage === 'folder'`, 'a team with no folder anywhere keeps the folder step', 8000);
        console.log('PASS Add agent picks the team home folder, else the first session that has a folder');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
