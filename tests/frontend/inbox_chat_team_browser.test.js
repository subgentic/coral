// #10592 (Beta Inbox pass #10573): two teams' Orchestrators both read "Orchestrator" in All chats. A chat of a live agent on a team says which team: on a desktop the Agent column reads "Orchestrator · Release crew", the
// title's hover names the team too, and a phone's mail row carries the team after the agent; an agent on no team stays "Orchestrator". At 1280 and 390; the history list is stubbed in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const stub = () => ev(`(async () => { const R = window.fetch; const now = Date.now();
        const row = (id, team, i) => ({ session_id: id, type: 'agent', title: 'Orchestrator', summary: 'm', agent_name: 'Orchestrator', display_name: 'Orchestrator', ...(team ? { board_name: team } : {}), last_timestamp: new Date(now - i * 3600000).toISOString(), duration_sec: 600, source_type: 'claude', starred: false, archived: false, active: false, tags: [] });
        const sessions = [row('orch-a', 'b-zdr72y6ndy', 0), row('orch-b', 'b-no-label', 1), row('orch-solo', '', 2)];
        (await import((window.__coralStatic || '/static/') + 'server_base.js')).noteBoardLabels([{ board_project: 'b-zdr72y6ndy', board_label: 'Release crew' }]);
        const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
            if (url.pathname === '/api/sessions/history/counts') return json({ all: 3, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: { claude: 3 }, tags: [] });
            if (url.pathname === '/api/sessions/history') return json({ sessions, total: 3, page: 1, page_size: 50 });
            return R(u, o); }; return true; })()`);
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            const at = `${width}: `;
            try {
            await Emulation.setDeviceMetricsOverride({ width, height: 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); await stub();
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length === 3`, at + 'the three chats', 15000);
            const rows = await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)')].map(r => { const b = r.querySelector('button.dt-primary'); return { text: r.textContent.replace(/\\s+/g, ' ').trim(), tip: b ? b.title : '', label: b ? b.getAttribute('aria-label') : '', agent: (r.querySelector('td[data-key="agent"]') || {}).textContent || '' }; })`);
            if (process.env.CORAL_SCREENSHOT_DIR) { const fs = require('node:fs'), d = process.env.CORAL_SCREENSHOT_DIR; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/chat-team-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            assert.ok(!rows.some(r => r.text.includes('b-zdr72y6ndy')), at + 'the known team display name replaces its board id: ' + JSON.stringify(rows));
            const byTeam = t => rows.find(r => r.text.includes('· ' + t));
            assert.ok(byTeam('Release crew') && byTeam('b-no-label'), at + 'each team is named on its chat: ' + JSON.stringify(rows.map(r => r.text)));
            assert.notEqual(byTeam('Release crew').text, byTeam('b-no-label').text, at + 'two teams Orchestrators read differently');
            const solo = rows.find(r => !/Release crew|b-no-label/.test(r.text));
            assert.ok(solo && /Orchestrator/.test(solo.text), at + 'an agent on no team is just its name: ' + JSON.stringify(rows.map(r => r.text)));
            if (!mobile) {
                assert.deepEqual(rows.map(r => r.agent.trim()), ['Orchestrator · Release crew', 'Orchestrator · b-no-label', 'Orchestrator'], at + 'the Agent column names the team');
                assert.match(byTeam('Release crew').tip, /Orchestrator · Release crew/, at + 'the hover of the title names the team');
                assert.match(byTeam('Release crew').label, /Orchestrator · Release crew/, at + 'and so does its name for a screen reader');
            }
            } catch (e) { failures.push(e.message); console.error(e.stack); }
        }
        assert.deepEqual(failures, []);
        console.log('\nAll chat-row team checks passed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
