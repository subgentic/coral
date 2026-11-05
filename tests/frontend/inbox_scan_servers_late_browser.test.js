// #13304: through a Hub the list of its computers arrives a moment after the page loads. A Needs you scan that started before it covered no computer, said 'Nothing needs you', and did not look again for 30 s (QA Engineer measured no rows in 30 s on the v2.0.46 build through a local Hub, against 1.0 s on the computer itself).
// The page here is a hub whose list of computers is empty when Needs you is opened and gets one computer a moment later: its rows must appear without waiting out 30 s.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch; window.__asked = [];
            const json = b => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
            const HEX = 'ab'.repeat(32);
            window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname; window.__asked.push(p + url.search);
                if (p === '/api/remote/box-2/api/board/projects') return Promise.resolve(json([{ project: 'alpha' }]));
                if (p === '/api/remote/box-2/api/board/alpha/artifacts') { const tag = url.searchParams.get('tag');
                    return Promise.resolve(json(tag === 'for review' ? { has_more: false, artifacts: [{ id: 'a-1', uri: 'coral://artifacts/' + HEX, tags: ['for review'], name: 'remote-report.md', created_at: '2026-11-04T00:00:01Z', available: true, produced_by: 'Dev', session_id: 's-1' }] } : { has_more: false, artifacts: [] })); }
                if (p.startsWith('/api/remote/')) return Promise.resolve(json({}));
                return real(u, o); }; })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const S = `(window.__coralStatic || '/static/')`;
        // a hub whose list of computers has not arrived: hub mode, no servers, none known
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.hub = true; state.servers = []; state.serversKnown = false; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`/Nothing needs you/.test(document.getElementById('group-table-view').innerText)`, 'the scan that found no computer says so', 8000);
        // the list arrives (the live list's answer or the feed's frame, which both call updateServersTabVisibility)
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.servers = [{ id: 'box-2', label: 'box-2', status: 'online' }]; state.serversKnown = true; const T = await import(${S} + 'servers_tab.js'); T.updateServersTabVisibility(); return true; })()`);
        await waitFor(`/remote-report/.test(document.getElementById('group-table-view').innerText)`, 'the computer that arrived late is read at once, not after 30 s', 6000);
        assert.ok(await ev(`window.__asked.some(p => p.startsWith('/api/remote/box-2/api/board/alpha/artifacts'))`), 'its team was read');
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exitCode = 1; });
