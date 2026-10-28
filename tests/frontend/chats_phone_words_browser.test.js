// Chats on a phone (#10738, Mobile pass 39): (1) a chat that is archived is not "running": it has no green now dot (the tester read it as running); (2) the empty list of a search says that archived chats are not listed
// there (after Back the old word was still in the box and "No chat matches the search and filters." read as gone, although the chat was in Archived), and in Archived itself it does not. At 390 px; the history read is
// stood in on the isolated dev server and the chat folders' table is drawn from the real mailbox_chats.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`(() => { const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            const row = (id, title, extra) => ({ session_id: id, type: 'agent', title, summary: 'a chat', agent_type: 'claude', source_type: 'claude', last_timestamp: new Date().toISOString(), duration_sec: 60, starred: false, archived: false, active: false, tags: [], server: 'local', ...extra });
            window.__rows = [row('chat-run', 'Running chat', { active: true }), row('chat-arch', 'Archived but running', { archived: true, active: true })];
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                if (url.pathname === '/api/sessions/history/counts') return json({ all: 1, group: 0, notes: 0, active: 1, starred: 0, archived: 1, by_agent_type: {}, tags: [] });
                if (url.pathname === '/api/sessions/history') { const q = url.searchParams.get('q') || url.searchParams.get('search') || ''; const arch = url.searchParams.get('archived') === '1'; const list = q ? [] : window.__rows.filter(r => arch ? r.archived : !r.archived); return json({ sessions: list, total: list.length, page: 1, page_size: 50 }); }
                return R(u, o); }; return true; })()`);
        const draw = (key, query) => ev(`(async () => { const m = await import(${S} + 'mailbox_chats.js'); const ctx = { query: ${JSON.stringify(query)}, params: {}, redraw() {}, after() {}, open() {} };
            for (let i = 0; i < 60; i++) { const spec = m.chatsSpec(${JSON.stringify(key)}, ctx); if (spec && !/Loading|Reading/.test((spec.empty || {}).line || 'x') && (spec.rows.length || (spec.empty || {}).line)) { const host = document.createElement('div'); host.id = 'probe-host'; document.body.append(host); if (spec.rows.length) host.append(spec.node()); const out = { empty: (spec.empty || {}).line || '', dots: host.querySelectorAll('.dt-mail-live').length, rows: spec.rows.length }; host.remove(); return out; } await new Promise(r => setTimeout(r, 100)); }
            return { empty: 'never settled', dots: -1, rows: -1 }; })()`); // sleep-ok: the folder's read settles in a few frames
        // (1) the archived chat's row has no running dot; a running chat's has one
        const arch = await draw('chats-archived', '');
        if (arch.rows !== 1) problems.push(`the Archived folder lists the archived chat (rows ${arch.rows})`);
        if (arch.dots !== 0) problems.push(`an archived chat has a green running dot (${arch.dots})`);
        const all = await draw('chats-active', '');
        if (all.dots < 1) problems.push(`a chat that is running keeps its dot (${all.dots})`);
        // (2) the empty list of a search
        const found = await draw('chats', 'canned');
        if (!/Archived chats are not listed here/.test(found.empty)) problems.push(`the empty search in All chats says archived chats are not listed there (it says "${found.empty}")`);
        const inArch = await draw('chats-archived', 'canned');
        if (/not listed here/.test(inArch.empty)) problems.push(`the Archived folder does not say that (it says "${inArch.empty}")`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'chats on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS archived chats have no running dot; an empty search says archived chats are not listed');
})().catch(e => { console.error(e); process.exit(1); });
