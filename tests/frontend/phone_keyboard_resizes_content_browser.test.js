// On Android Chrome the keyboard resizes the page itself (the viewport meta's interactive-widget=resizes-content), so the page keeps the CSS's own 100dvh and does not store a copy of the visual viewport (#13236, from the
// Android report through the Hub: the composer cut in half and a ~70 px dark band over the keyboard, the stored copy read before Chrome settled and never read again). The late-settle order is reproduced: the layout viewport
// is resized to what the keyboard leaves (real, by the emulation), and the visual viewport's one resize event reports a height 70 px stale; Chrome on Android has navigator.virtualKeyboard, iOS Safari has not and keeps the stored
// height. 390 px with touch; drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const FAKE_VV = android => `(() => { ${android ? "Object.defineProperty(navigator, 'virtualKeyboard', { configurable: true, value: {} });" : "delete Navigator.prototype.virtualKeyboard;"}
    const t = new EventTarget(); const vv = { height: innerHeight, width: innerWidth, scale: 1, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, addEventListener: (...a) => t.addEventListener(...a), removeEventListener: (...a) => t.removeEventListener(...a), dispatchEvent: e => t.dispatchEvent(e) };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    window.__stale = (h) => { vv.height = h; t.dispatchEvent(new Event('resize')); }; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    let sid = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [android, chrome100] of [[true, false], [true, true], [false, false]]) {
            if (sid) await Page.removeScriptToEvaluateOnNewDocument({ identifier: sid });
            sid = (await Page.addScriptToEvaluateOnNewDocument({ source: FAKE_VV(android) })).identifier;
            const tag = chrome100 ? 'Chrome 100 (virtualKeyboard, no resizes-content)' : android ? 'Android (resizes-content)' : 'iOS (no virtualKeyboard)';
            await Emulation.setUserAgentOverride({ userAgent: chrome100 ? 'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Mobile Safari/537.36' : '' });
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.__m.add('kb-agent', 'A', 14, { sleeping: false, session_id: 'kb-id' }); true`);
            await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'kb-agent')`, `${tag}: the agent`, 10000);
            await ev(`window.selectLiveSession('kb-agent', 'claude', 'kb-id', 'local'); true`);
            await waitFor(`!!document.querySelector('#command-pane') && document.getElementById('command-input')?.getClientRects().length > 0`, `${tag}: the composer`, 10000);
            // the keyboard opens: the layout viewport is 520 px; the visual viewport's resize event is read 70 px too tall (before it settled) and no event follows
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 520, deviceScaleFactor: 1, mobile: true });
            await ev(`window.__stale(590); true`);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: layout after a resize has no event
            const g = await ev(`(() => { const p = document.querySelector('#command-pane').getBoundingClientRect(); return { inner: innerHeight, body: Math.round(document.body.getBoundingClientRect().height), paneBottom: Math.round(p.bottom), prop: document.documentElement.style.getPropertyValue('--visual-viewport-height') }; })()`);
            if (android && !chrome100) {
                assert.equal(g.prop, '', `${tag}: no stored copy of the visual viewport: ` + JSON.stringify(g));
                assert.ok(Math.abs(g.body - g.inner) <= 1, `${tag}: the page is as tall as the layout viewport (100dvh), not the stale reading: ` + JSON.stringify(g));
                assert.ok(g.paneBottom <= g.inner + 1 && g.paneBottom >= g.inner - 8, `${tag}: the composer sits flush on the keyboard: ` + JSON.stringify(g));
            } else {
                assert.equal(g.prop, '590px', `${tag}: the stored height is kept (no resizes-content here): ` + JSON.stringify(g));
            }
        }
        console.log('PASS the composer sits on the keyboard on Android (100dvh, no stored copy); iOS keeps the stored height');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
