// #18905: a real empty feed update before install must not erase the notice fixture agent.
// Hold then deliver the first feed update to reproduce the ordering deterministically.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD + require('./helpers/launch_notice_agent').PRELOAD });
        // The real feed's handler is held (its messages queue) until __letFeedIn(): the late first update of the race.
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const Real = window.WebSocket; window.__held = []; window.__feedHandler = null;
            function W(u, p) { const s = new (p === undefined ? Real : Real)(u, p); if (/\\/ws\\/coral/.test(String(u))) { Object.defineProperty(s, 'onmessage', { set(f) { window.__feedHandler = f; }, get() { return window.__feedHandler; } }); s.addEventListener('message', e => { window.__held.push(e); }); }
                return s; }
            W.prototype = Real.prototype; W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3; window.WebSocket = W;
            window.__letFeedIn = () => { let n = 0; for (const e of window.__held.splice(0)) { if (window.__feedHandler) { window.__feedHandler(e); n++; } } return n; }; })();` });
        await Emulation.setDeviceMetricsOverride({ width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired();
        console.log('1. the real feed has sent its first update, the mocked list is served, and the update lands before install() detaches the feed');
        await waitFor(`window.__held.length > 0 && !!window.__liveListServed`, 'the feed update and the served list', 10000);
        await waitFor(`import((window.__coralStatic||'/static/')+'state.js').then(m => m.state.liveSessions.some(s => s.session_id === 'notice-fixture'))`, 'the fixture agent loaded from the list', 10000);
        assert.ok(await ev(`window.__letFeedIn() > 0`), 'a feed update was let in');
        assert.equal(await ev(`import((window.__coralStatic||'/static/')+'state.js').then(m => m.state.liveSessions.length)`), 0, 'the real empty feed replaced the fixture before install');
        await install();
        console.log('2. the mocked agent is still listed');
        await waitFor(`import((window.__coralStatic||'/static/')+'state.js').then(m => m.state.liveSessions.some(s => s.session_id === 'notice-fixture'))`, 'the fixture agent restored after the late feed update', 3000);
        console.log('PASS notice fixture survives the real feed race');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
