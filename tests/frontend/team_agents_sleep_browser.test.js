// After Sleep Team the Agents tab says Sleeping at once, not at the next 15 s poll (#12335, Beta Tester: the table said Free/Waiting while the sidebar said Sleeping).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-sleep-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM);
        await ev(`(() => { window.__asleep = false; const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/board/${TEAM}/status') { const av = window.__asleep ? 'sleeping' : 'available'; const why = window.__asleep ? 'Agent is sleeping' : 'Idle';
                const agents = ['Orchestrator', 'Backend Dev'].map(name => ({ name, subscriber_id: name, agent_type: 'claude', availability: av, available: !window.__asleep, reason: why }));
                return Promise.resolve(new Response(JSON.stringify({ agents, summary: { total: 2, available: window.__asleep ? 0 : 2, sleeping: window.__asleep ? 2 : 0, archived: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM); await settle(500);
        await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); t.click(); return true; })()`);
        await waitFor(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).length === 2`, 'the two agents in the table', { timeout: 8000 });
        const before = await ev(`document.querySelector('.team-agents-body').textContent`);
        assert.ok(!/Sleeping/.test(before), 'awake before the sleep: ' + before.slice(0, 200));
        await ev(`(() => { window.__asleep = true; document.dispatchEvent(new CustomEvent('coral:team-sleep-changed', { detail: { team: '${TEAM}' } })); return true; })()`);
        const t0 = Date.now();
        await waitFor(`/Sleeping/.test(document.querySelector('.team-agents-body').textContent)`, 'the table says Sleeping', { timeout: 20000 });
        assert.ok(Date.now() - t0 < 4000, 'the table said Sleeping at once, not at the 15 s poll: ' + (Date.now() - t0) + ' ms');
        console.log('PASS the Agents table follows Sleep Team at once');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
