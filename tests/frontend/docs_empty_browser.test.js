// Docs with no documentation in the build says so on the screen a person is looking at (#10266 point 1): a wide screen's content pane and a phone's list, which is the phone's page and was left blank.
// 390 and 1280 px; /api/agent-docs is stubbed to answer an empty list. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => /\\/api\\/agent-docs(\\?|$)/.test(String(u && u.url || u)) ? Promise.resolve(new Response('[]', { headers: { 'content-type': 'application/json' } })) : R(u, o); return true; })()`);
            await ev(`window.switchNavTab('docs'); true`);
            await waitFor(`document.getElementById('docs-view') && document.getElementById('docs-view').getClientRects().length > 0 && !/Loading/.test(document.getElementById('docs-content').textContent)`, `${w}: the docs tab loaded`, 8000);
            const seen = await ev(`(() => { const shown = e => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
                const els = [...document.querySelectorAll('#docs-view .empty-state, #docs-view [id^="docs-"]')].filter(shown);
                return els.map(e => e.textContent.trim()).filter(t => /No documentation/.test(t)); })()`);
            assert.ok(seen.length > 0, `${w}: a visible line says there is no documentation (${w < 500 ? 'a phone shows the list' : 'the content pane'})`);
        }
        console.log('PASS Docs with none: the page says so at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
