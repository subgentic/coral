// A phone's chat row says its words once (#14665, coral-hub's find): an imported chat with no agent name and no matched words has its history label as the row's title, and the second line fell back to the same label, so the row read the
// same text twice. The second line is empty then (or the team alone); a chat with an agent keeps its two lines (the agent, then the chat's title) and a search's hit still shows. At 390 px; the history read is stood in on the isolated
// dev server and the chat folder's table is drawn from the real mailbox_chats.js (as chats_phone_words_browser).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(() => { const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            const row = (id, title, extra) => ({ session_id: id, type: 'agent', title, summary: title, agent_type: 'claude', source_type: 'claude', last_timestamp: new Date().toISOString(), duration_sec: 60, starred: false, archived: false, active: false, tags: [], server: 'local', ...extra });
            window.__rows = [row('imported-1', 'Planning notes for the launch page'), row('agent-1', 'Fix the login page', { display_name: 'Frontend Dev' })];
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                if (url.pathname === '/api/sessions/history/counts') return json({ all: 2, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: {}, tags: [] });
                if (url.pathname === '/api/sessions/history') return json({ sessions: window.__rows, total: window.__rows.length, page: 1, page_size: 50 });
                return R(u, o); }; return true; })()`);
        const lines = await ev(`(async () => { const m = await import(${S} + 'mailbox_chats.js'); const ctx = { query: '', params: {}, redraw() {}, after() {}, open() {} };
            for (let i = 0; i < 60; i++) { const spec = m.chatsSpec('chats', ctx); if (spec && spec.rows.length === 2) { const host = document.createElement('div'); host.id = 'probe-host'; document.body.append(host); host.append(spec.node());
                const out = [...host.querySelectorAll('tbody tr.dt-row')].map(tr => ({ title: ((tr.querySelector('.dt-mail-title') || {}).textContent || '').trim(), snippet: ((tr.querySelector('.dt-mail-snippet') || {}).textContent || '').trim() })); host.remove(); return out; }
                await new Promise(r => setTimeout(r, 100)); } /* sleep-ok: the folder's read settles in a few frames */ return null; })()`);
        assert.ok(lines && lines.length === 2, 'two chat rows drew: ' + JSON.stringify(lines));
        const imported = lines.find(l => /Planning notes/.test(l.title + l.snippet)), agent = lines.find(l => /Frontend Dev/.test(l.title));
        if (!imported) problems.push('the imported chat has a row: ' + JSON.stringify(lines));
        else {
            if (imported.snippet === imported.title) problems.push(`the imported chat's second line repeats its title: "${imported.title}" twice`);
            if (!/Planning notes for the launch page/.test(imported.title)) problems.push(`the imported chat's title says its label: ${JSON.stringify(imported)}`);
        }
        if (!agent || !/Fix the login page/.test(agent.snippet)) problems.push('a chat with an agent keeps its two lines (the agent, then the chat\'s title): ' + JSON.stringify(agent));
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'chats on a phone:\n  ' + problems.join('\n  '));
    console.log('chats_phone_title_once_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
