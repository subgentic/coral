// #11990: Settings > Storage and cleanup has the chat import's one switch: with earlier chats waiting it says how many are found and offers Import; once imported it says so and offers
// "Stop listing chats Coral did not start" (a POST of {imported:false}); nothing is deleted from disk. The server side is in internal/background/indexer_import_test.go and
// internal/server/routes/history_import_test.go; here the route is stubbed. Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`(() => { const R = window.fetch; window.__imp = { imported: false, found: 40, listed: 0, sources: { claude: 40 }, ready: true }; window.__posts = [];
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname; const m = (o.method || 'GET').toUpperCase();
                if (p === '/api/history-import') { if (m === 'POST') { const b = o.body ? JSON.parse(o.body) : {}; window.__posts.push(b); window.__imp = b.imported === false ? { imported: false, found: 40, listed: 0, sources: { claude: 40 }, ready: true } : { imported: true, found: 0, listed: 40, sources: {}, ready: true }; return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                    return Promise.resolve(new Response(JSON.stringify(window.__imp), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); };
            return true; })()`);
        await ev(`window.showSettingsModal('cleanup'); true`);
        const state = () => ev(`(() => { const s = document.getElementById('settings-chat-import-status'), b = document.getElementById('settings-chat-import'); return { text: s.textContent, label: b.textContent, shown: !s.hidden && !b.hidden }; })()`);
        await waitFor(`!!document.getElementById('settings-chat-import') && !document.getElementById('settings-chat-import').hidden`, 'the chat import row', 8000);
        let st = await state();
        assert.deepEqual(st, { text: 'Chats Coral did not start are not listed: 40 found on this computer.', label: 'Import 40 earlier chats', shown: true });
        await ev(`document.getElementById('settings-chat-import').click(); true`);
        await waitFor(`(document.getElementById('settings-chat-import') || {}).textContent === 'Stop listing chats Coral did not start'`, 'the switch to flip to Stop', 8000);
        st = await state();
        assert.match(st.text, /are listed: 40\.$/);
        assert.deepEqual(await ev('window.__posts'), [{ imported: true }]);
        await ev(`document.getElementById('settings-chat-import').click(); true`);
        await waitFor(`(document.getElementById('settings-chat-import') || {}).textContent === 'Import 40 earlier chats'`, 'the switch to flip back', 8000);
        assert.deepEqual(await ev('window.__posts'), [{ imported: true }, { imported: false }]);
        console.log('PASS');
    } catch (e) {
        console.error(e && e.stack || e);
        process.exitCode = 1;
    } finally { await client.close(); }
})();
