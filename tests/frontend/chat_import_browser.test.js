// A brand-new Coral does not list the chats it did not start (#11970, Beta #11966: "All chats 40" on a new Mac was Claude Code's own history). The empty All chats says how many earlier
// chats were found and from which CLIs, with an Import button; the button POSTs /api/history-import once and the offer goes. Nothing waiting: no button. The server is stood in at
// GET and POST /api/history-import, the counts and the history read. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await ev(`(() => { window.__posts = 0; window.__imported = false;
            const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                if (url.pathname === '/api/history-import') { if ((o.method || 'GET') === 'POST') { window.__posts++; window.__imported = true; return json({ ok: true }); }
                    return json(window.__imported ? { imported: true, found: 0, sources: {}, ready: true } : { imported: false, found: 40, sources: { claude: 31, codex: 9 }, ready: true }); }
                if (url.pathname === '/api/sessions/history/counts') return json({ all: 0, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: {}, tags: [] });
                if (url.pathname === '/api/sessions/history') return json({ sessions: window.__rows || [], total: (window.__rows || []).length, page: 1, page_size: 50 });
                return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })); };
            return true; })()`);
        const empty = () => ev(`import((window.__coralStatic || '/static/') + 'mailbox_chats.js').then(m => { const e = m.chatsSpec('chats', { query: '', params: {}, redraw() {}, after() {} }).empty; return { line: e.line, hint: e.hint || '', label: e.action ? e.action.label : '' }; })`);
        await ev(`import((window.__coralStatic || '/static/') + 'mailbox_chats.js').then(m => m.loadChatCounts())`);
        await empty(); await settle(800); // the first look starts the history read
        const e = await empty();
        assert.equal(e.label, 'Import 40 earlier chats from Claude Code, Codex', JSON.stringify(e));
        assert.match(e.hint, /^40 earlier chats were found on this computer \(Claude Code, Codex\)\. They are not listed until you import them\.$/);
        await ev(`import((window.__coralStatic || '/static/') + 'mailbox_chats.js').then(m => m.chatsSpec('chats', { query: '', params: {}, redraw() {}, after() {} }).empty.action.run())`);
        await settle(300);
        assert.equal(await ev('window.__posts'), 1, 'the button imports once');
        assert.equal((await empty()).label, '', 'the offer goes once imported');
        // A list that HAS chats keeps the offer reachable: a line above it with the same words and button (the person's own agents' chats are listed at once on a new Coral).
        await ev(`window.__imported = false; window.__posts = 0; window.__rows = [{ session_id: 'mine-1', type: 'agent', title: 'My chat', source_type: 'claude', agent_name: 'dev', last_timestamp: new Date().toISOString(), message_count: 2 }]; true`);
        const banner = () => ev(`import((window.__coralStatic || '/static/') + 'mailbox_chats.js').then(async m => { await m.loadChatCounts(); const sp = m.chatsSpec('chats', { query: '', params: {}, redraw() {}, after() {} }); const n = sp.rows.length ? sp.node() : null; const b = n && n.querySelector('.chat-import-line'); return { rows: sp.rows.length, text: b ? b.textContent : '' }; })`);
        await ev(`import((window.__coralStatic || '/static/') + 'mailbox_chats.js').then(m => { m.resetChatLists(); return true; })`);
        await banner(); await settle(800);
        const withRows = await banner();
        assert.equal(withRows.rows, 1, JSON.stringify(withRows));
        assert.match(withRows.text, /^40 earlier chats were found on this computer \(Claude Code, Codex\)\..*Import 40 earlier chats from Claude Code, Codex$/, withRows.text);
        // With a search or a filter active the offer is not drawn above the result list (it is the whole folder's, not the search's).
        const probeS = () => ev(`import((window.__coralStatic || '/static/') + 'mailbox_chats.js').then(m => { const sp = m.chatsSpec('chats', { query: 'my', params: {}, redraw() {}, after() {} }); const n = sp.rows.length ? sp.node() : null; return { rows: sp.rows.length, banner: !!(n && n.querySelector('.chat-import-line')) }; })`);
        const probeF = () => ev(`import((window.__coralStatic || '/static/') + 'mailbox_chats.js').then(m => { const sp = m.chatsSpec('chats', { query: '', params: { source_types: 'claude' }, redraw() {}, after() {} }); const n = sp.rows.length ? sp.node() : null; return { banner: !!(n && n.querySelector('.chat-import-line')) }; })`);
        await probeS(); await probeF(); await settle(800); // the first look of each starts its read
        const searched = await probeS(), filtered = await probeF();
        assert.equal(searched.rows, 1, 'the search lists the chat: ' + JSON.stringify(searched));
        assert.equal(searched.banner, false, 'no offer above a search: ' + JSON.stringify(searched));
        assert.equal(filtered.banner, false, 'no offer above a filtered list');
        console.log('PASS the empty All chats offers the import and the button imports once');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
