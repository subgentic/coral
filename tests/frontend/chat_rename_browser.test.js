// Naming a past chat (#10390, Desktop #10384): the Rename button on a chat's row and on its page asks for a name and sends it with the flags route ({ title }); the reply's title is what the row and the page show; an empty
// name asks for the automatic title back. 1280 px, isolated dev server, the harness's page; the history read and the flags PATCH are stood in.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`(() => { const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            window.__flags = [];
            const row = { session_id: 'chat-rn-1', type: 'agent', title: 'fix the importer crash', summary: 'a chat', agent_type: 'claude', source_type: 'claude', last_timestamp: new Date().toISOString(), duration_sec: 60, starred: false, archived: false, active: false, tags: [], server: 'local' };
            window.__row = row;
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                if (/\\/api\\/sessions\\/history\\/chat-rn-1\\/flags$/.test(url.pathname)) { const b = JSON.parse(o.body); window.__flags.push(b); row.chat_title = b.title; row.title = b.title === '' ? 'fix the importer crash' : b.title; return json({ ok: true, title: row.title }); } // the server's side: the list is read again with the name
                if (url.pathname === '/api/sessions/history/counts') return json({ all: 1, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: {}, tags: [], dirs: [] });
                if (url.pathname === '/api/sessions/history') return json({ sessions: [row], total: 1, page: 1, page_size: 50 });
                if (/\\/api\\/sessions\\/history\\/chat-rn-1/.test(url.pathname)) return json({ messages: [], session_id: 'chat-rn-1' });
                return R(u, o); };
            return true; })()`);
        await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); state.historySessionsList = [{ ...window.__row }]; return true; })()`);
        // the row's button
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr:not(.dt-group)').length === 1`, 'the chat row', 15000);
        const rename = async (name) => {
            await waitFor(`document.getElementById('prompt-modal').style.display === 'flex'`, 'the name dialog', 6000);
            assert.equal(await ev(`document.getElementById('prompt-modal-title').textContent`), 'Rename chat');
            await ev(`(() => { const i = document.getElementById('prompt-modal-input'); i.value = ${JSON.stringify(name)}; document.getElementById('prompt-modal-ok').click(); return true; })()`);
        };
        await ev(`document.querySelector('#group-table-view button[data-flag="edit"]').click(); true`);
        await waitFor(`document.getElementById('prompt-modal').style.display === 'flex'`, 'the name dialog', 6000);
        assert.match(await ev(`document.getElementById('prompt-modal-label').textContent`), /past chat, kept on this computer; it is not the agent's name/, 'the help says where the name is kept and what it names');
        assert.equal(await ev(`document.getElementById('prompt-modal-input').value`), 'fix the importer crash', 'the dialog starts from the title shown');
        await rename('Importer crash review');
        await waitFor(`window.__flags.length === 1`, 'the flags request', 6000);
        assert.deepEqual(await ev(`window.__flags`), [{ title: 'Importer crash review' }]);
        await waitFor(`/Importer crash review/.test(document.querySelector('#group-table-view .dt-table tbody button.dt-primary')?.textContent || '')`, 'the row shows the name', 6000);
        // an unchanged name sends nothing; an empty one asks for the automatic title back
        await ev(`document.querySelector('#group-table-view button[data-flag="edit"]').click(); true`);
        await rename('Importer crash review');
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: a negative check, nothing is sent
        assert.equal(await ev(`window.__flags.length`), 1, 'the same name is not sent again');
        await ev(`document.querySelector('#group-table-view button[data-flag="edit"]').click(); true`);
        await rename('');
        await waitFor(`window.__flags.length === 2`, 'the empty name', 6000);
        assert.deepEqual(await ev(`window.__flags[1]`), { title: '' });
        await waitFor(`/fix the importer crash/.test(document.querySelector('#group-table-view .dt-table tbody button.dt-primary')?.textContent || '')`, 'the row shows the automatic title', 6000);
        // its page
        await ev(`Promise.resolve(window.selectHistorySession('chat-rn-1')).then(() => true)`);
        await waitFor(`!!document.getElementById('history-rename') && !document.getElementById('history-flags').hidden`, 'the chat page and its Rename', 8000);
        await ev(`document.getElementById('history-rename').click(); true`);
        await rename('Page name');
        await waitFor(`document.getElementById('history-session-title').textContent === 'Page name'`, 'the page title is the name', 6000);
        assert.deepEqual(await ev(`window.__flags[2]`), { title: 'Page name' });
        console.log('PASS a past chat is renamed from its row and its page');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
