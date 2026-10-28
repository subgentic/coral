// The Inbox's empty chat folders say what fills them (#10371, Beta #10367: five lists said "No chats here." and With notes and Active now gave no way to fill them): All chats, With notes and Active now
// each have their own line; Starred and Archived keep theirs. The history read is stood in at GET /api/sessions/history (nothing in it). 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                if (url.pathname === '/api/sessions/history/counts') return json({ all: 0, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: {}, tags: [] });
                if (url.pathname === '/api/sessions/history') return json({ sessions: [], total: 0, page: 1, page_size: 50 });
                return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })); };
            return true; })()`);
        const line = key => ev(`import((window.__coralStatic || '/static/') + 'mailbox_chats.js').then(m => m.chatsSpec(${JSON.stringify(key)}, { query: '', params: {}, redraw() {}, after() {} }).empty.line)`);
        const want = { 'chats': /^No chats yet\. Start an agent and its conversation is listed here\.$/, 'chats-notes': /^No chats with notes yet\. A chat you add a note to is listed here\.$/, 'chats-active': /^No chat is active now\. Chats of agents that are running are listed here\.$/,
            'chats-starred': /^Nothing starred yet\.$/, 'chats-archived': /^No archived chats yet\. Archive a chat or an agent and it is kept here\.$/ };
        for (const key of Object.keys(want)) await line(key); // the first look starts the read
        await settle(800);
        const seen = new Set();
        for (const [key, rx] of Object.entries(want)) { const l = await line(key); assert.match(l, rx, `${key}: ${l}`); seen.add(l); }
        assert.equal(seen.size, 5, 'five folders, five different lines: ' + [...seen].join(' | '));
        console.log('PASS the empty chat folders say what fills them');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
