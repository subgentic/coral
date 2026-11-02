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
                if (url.pathname === '/api/sessions/history') return json({ sessions: [], total: 0, page: 1, page_size: 50 });
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
        console.log('PASS the empty All chats offers the import and the button imports once');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
