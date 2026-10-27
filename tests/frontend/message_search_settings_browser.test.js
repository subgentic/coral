// #9685: Settings > Storage says whether the board message search index is on, its state (building, ready) and the disk it takes; an unreadable status, a build without FTS5 and the setting off each say so.
// The server side (the setting, the state, the size) is in internal/board/message_fts_default_test.go and internal/server/routes/message_search_index_test.go; here the route is stubbed.
// Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

const MIB = 1024 ** 2;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch; window.__idx = { setting: 'on', available: true, state: 'ready', size_bytes: ${12 * MIB} }; window.__down = false;
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname; const m = (o.method || 'GET').toUpperCase();
                if (p === '/api/system/message-search-index' && m === 'GET') return Promise.resolve(new Response(JSON.stringify(window.__down ? { error: 'x' } : window.__idx), { status: window.__down ? 503 : 200, headers: { 'Content-Type': 'application/json' } }));
                return R(u, o); };
            return true; })()`);
        const line = async () => {
            await waitFor(`(window.hideSettingsModal(), (!document.getElementById('settings-modal') || getComputedStyle(document.getElementById('settings-modal')).display === 'none'))`, 'Settings to close', 6000);
            await ev(`window.showSettingsModal('cleanup'); true`);
            await waitFor(`!!document.getElementById('settings-message-search-status') && !/Loading/.test(document.getElementById('settings-message-search-status').textContent)`, 'the search index line', 8000);
            return ev(`(() => { const e = document.getElementById('settings-message-search-status'); return { text: e.textContent, role: e.getAttribute('role'), title: (document.getElementById('settings-message-search-title') || {}).textContent || '' }; })()`);
        };
        const cases = [
            ['on and ready: the disk it takes', { setting: 'on', available: true, state: 'ready', size_bytes: 12 * MIB }, 'On and ready. It takes 12 MiB of disk.'],
            ['on and building', { setting: 'on', available: true, state: 'building', size_bytes: 0 }, 'On, building in the background: a search reads every message until it is ready.'],
            ['off by the setting', { setting: 'off', available: true, state: 'off', size_bytes: 0 }, 'Off (CORAL_BOARD_SEARCH_INDEX=off): a search reads every message.'],
            ['a build without FTS5', { setting: 'on', available: false, state: 'off', size_bytes: 0 }, 'Not in this build: a search reads every message.'],
        ];
        let n = 0;
        for (const [name, body, want] of cases) {
            console.log(`${++n}. ${name}`);
            await ev(`window.__down = false; window.__idx = ${JSON.stringify(body)}; true`);
            const st = await line();
            assert.equal(st.text, want, JSON.stringify(st));
            assert.equal(st.role, 'status');
            assert.equal(st.title, 'Board message search');
        }
        console.log(`${++n}. an unreadable status says so`);
        await ev(`window.__down = true; true`);
        assert.equal((await line()).text, "Couldn't read the search index.");
        console.log('PASS');
    } catch (e) {
        console.error(e && e.stack || e);
        process.exitCode = 1;
    } finally {
        try { await client.close(); } catch (_) {}
    }
})();
