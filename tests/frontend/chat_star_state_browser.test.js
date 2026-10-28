// One star state everywhere (#10391, Desktop #10384: a chat starred from the Inbox list showed unstarred on its own page, aria-pressed false): starring a chat from a folder's list (setChatFlag, the list's own
// star button) is the star its page shows when it is opened, and the page's own Star toggles it back in the list's cache. 1280 px, isolated dev server, the harness's page; the history read and the flags PATCH are stood in.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`(() => { const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            window.__flags = [];
            const row = { session_id: 'chat-star-1', type: 'agent', title: 'Starred from the list', summary: 'a chat', agent_type: 'claude', source_type: 'claude', last_timestamp: new Date().toISOString(), duration_sec: 60, starred: false, archived: false, active: false, tags: [], server: 'local' };
            window.__row = row;
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                if (/\\/api\\/sessions\\/history\\/chat-star-1\\/flags$/.test(url.pathname)) { window.__flags.push(JSON.parse(o.body)); return json({ ok: true }); }
                if (url.pathname === '/api/sessions/history/counts') return json({ all: 1, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: {}, tags: [] });
                if (url.pathname === '/api/sessions/history') return json({ sessions: [row], total: 1, page: 1, page_size: 50 });
                if (/\\/api\\/sessions\\/history\\/chat-star-1/.test(url.pathname)) return json({ messages: [], session_id: 'chat-star-1' });
                return R(u, o); };
            return true; })()`);
        // the history list the page keeps (what the sidebar and the chat page read)
        await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); state.historySessionsList = [{ ...window.__row }]; return true; })()`);
        // starred from the folder's list
        assert.equal(await ev(`import((window.__coralStatic || '/static/') + 'mailbox_chats.js').then(m => m.setChatFlag('chat-star-1', 'starred', true, 'local'))`), true, 'the list saved the star');
        assert.deepEqual(await ev(`window.__flags`), [{ starred: true }], 'the flags route was asked once');
        // its own page
        await ev(`Promise.resolve(window.selectHistorySession('chat-star-1')).then(() => true)`); // the entry point a person's click reaches
        await waitFor(`!!document.getElementById('history-star') && !document.getElementById('history-flags').hidden`, 'the chat page and its flags', 8000);
        const star = await ev(`(() => { const b = document.getElementById('history-star'); return { pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label') }; })()`);
        assert.deepEqual(star, { pressed: 'true', label: 'Remove the star' }, 'the page shows the star the list gave: ' + JSON.stringify(star));
        console.log('PASS a chat starred from the list is starred on its own page');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
