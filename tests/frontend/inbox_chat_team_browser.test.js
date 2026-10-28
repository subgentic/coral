// #10592 (Beta Inbox pass #10573): two teams' Orchestrators both read "Orchestrator" in All chats. A chat of a live agent on a team says which team: on a desktop the Agent column reads "Orchestrator · alpha", the
// title's hover names the team too, and a phone's mail row carries the team after the agent; an agent on no team stays "Orchestrator". At 1280 and 390; the history list is stubbed in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const stub = () => ev(`(() => { const R = window.fetch; const now = Date.now();
        const row = (id, team, i) => ({ session_id: id, type: 'agent', title: 'Orchestrator', summary: 'm', agent_name: 'Orchestrator', display_name: 'Orchestrator', ...(team ? { board_name: team } : {}), last_timestamp: new Date(now - i * 3600000).toISOString(), duration_sec: 600, source_type: 'claude', starred: false, archived: false, active: false, tags: [] });
        const sessions = [row('orch-a', 'alpha', 0), row('orch-b', 'beta', 1), row('orch-solo', '', 2)];
        const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
            if (url.pathname === '/api/sessions/history/counts') return json({ all: 3, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: { claude: 3 }, tags: [] });
            if (url.pathname === '/api/sessions/history') return json({ sessions, total: 3, page: 1, page_size: 50 });
            return R(u, o); }; return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            const at = `${width}: `;
            await Emulation.setDeviceMetricsOverride({ width, height: 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await stub();
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length === 3`, at + 'the three chats', 15000);
            const rows = await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')].map(r => { const b = r.querySelector('button.dt-primary'); return { text: r.textContent.replace(/\\s+/g, ' ').trim(), tip: b ? b.title : '', label: b ? b.getAttribute('aria-label') : '', agent: (r.querySelector('td[data-key="agent"]') || {}).textContent || '' }; })`);
            const byTeam = t => rows.find(r => r.text.includes('· ' + t));
            assert.ok(byTeam('alpha') && byTeam('beta'), at + 'each team is named on its chat: ' + JSON.stringify(rows.map(r => r.text)));
            assert.notEqual(byTeam('alpha').text, byTeam('beta').text, at + 'two teams Orchestrators read differently');
            const solo = rows.find(r => !/alpha|beta/.test(r.text));
            assert.ok(solo && /Orchestrator/.test(solo.text), at + 'an agent on no team is just its name: ' + JSON.stringify(rows.map(r => r.text)));
            if (!mobile) {
                assert.deepEqual(rows.map(r => r.agent.trim()), ['Orchestrator · alpha', 'Orchestrator · beta', 'Orchestrator'], at + 'the Agent column names the team');
                assert.match(byTeam('alpha').tip, /Orchestrator · alpha/, at + 'the hover of the title names the team');
                assert.match(byTeam('alpha').label, /Orchestrator · alpha/, at + 'and so does its name for a screen reader');
            }
        }
        console.log('\nAll chat-row team checks passed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
