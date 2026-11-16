// Customize tabs includes the lazy Sub-agents tab when it is present, and row names have no digits (#18430).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { settle, coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const open = async () => { await ev(`document.getElementById('agentic-tab-customize').click(); true`); await waitFor(`!!document.getElementById('tab-customize')`, 'popover opens'); };
    const close = async () => { await ev(`document.getElementById('tab-customize')?.remove(); true`); };
    const listed = () => ev(`[...document.querySelectorAll('#tab-customize .tc-row')].map(r => r.dataset.tab)`);
    const names = () => ev(`[...document.querySelectorAll('#tab-customize .tc-name')].map(e => e.textContent)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`localStorage.setItem('coral-agentic-tab-prefs', '{"agent":{"order":[],"hidden":[]}}'); true`);
        const SUBS = [{ id: 1, subagent_id: 'sa1', session_id: 'sid', subagent_type: 'Explore', description: 'Search logs', status: 'completed', finished: true, started_at: '2026-11-15T10:00:00Z', last_activity_at: '2026-11-15T10:01:00Z', api_calls: 5, cost_usd: 0.1 }];
        await ev(`window.__subs = ${JSON.stringify(SUBS)}; const real = window.fetch;
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (/\\/subagents$/.test(p.pathname)) return Promise.resolve(new Response(JSON.stringify(window.__subs), { status: 200, headers: { 'Content-Type': 'application/json' } })); return real(u, o); };
            window.__m.add('dev', 'S', 1, { sleeping: false, board_project: 'team-a', board_is_orchestrator: false, board_subscriber_id: 'Dev', display_name: 'Dev' }); true`);
        await settle(ev, 600);
        await ev(`window.selectLiveSession('dev', 'claude', 'sid', 'local'); true`);
        await ev(`(() => { const d = document.getElementById('agentic-state'); if (d.getBoundingClientRect().width < 50 || d.classList.contains('collapsed')) (document.getElementById('panel-toggle-btn') || document.getElementById('popout-panel-toggle-btn'))?.click(); return true; })()`);
        await waitFor(`!!document.getElementById('agentic-tab-subagents')`, 'Sub-agents tab appears', 6000);
        await open();
        const ids = await listed();
        assert.ok(ids.includes('subagents'), 'Customize tabs lists the Sub-agents tab: ' + JSON.stringify(ids));
        const rowNames = await names();
        for (const n of rowNames) assert.ok(!/\d/.test(n), `row name "${n}" must have no digits`);
        assert.ok(rowNames.some(n => /Sub-agents/i.test(n)), 'a row is named Sub-agents: ' + JSON.stringify(rowNames));
        await close();
        console.log('PASS customize tabs includes Sub-agents and row names have no digits');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
