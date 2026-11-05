// The agent-view harness mocks the live list over HTTP and detaches the real feed in install(), because the real feed answers with the test server's EMPTY list and would replace the mocked agents.
// That detach comes after the page has loaded, so a first feed update that landed between the mocked list being applied and the detach wiped the rows, and nothing drew them again: agent_instructions_browser
// waited its 15 s for the agent rows once in the trial-250 gate (retry passed in 1 s). Here the real feed's messages are held until the list has been applied, then let in just before install(): the mocked agents
// must still be on screen afterwards. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `window.__m.add('race-a', 'x', 2, { sleeping: false, session_id: 'sid-race-1' });` });
        // The real feed's handler is held (its messages queue) until __letFeedIn(): the late first update of the race.
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const Real = window.WebSocket; window.__held = []; window.__feedHandler = null;
            function W(u, p) { const s = new (p === undefined ? Real : Real)(u, p); if (/\\/ws\\/coral/.test(String(u))) { Object.defineProperty(s, 'onmessage', { set(f) { window.__feedHandler = f; }, get() { return window.__feedHandler; } }); s.addEventListener('message', e => { window.__held.push(e); }); }
                return s; }
            W.prototype = Real.prototype; W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3; window.WebSocket = W;
            window.__letFeedIn = () => { let n = 0; for (const e of window.__held.splice(0)) { if (window.__feedHandler) { window.__feedHandler(e); n++; } } return n; }; })();` });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired();
        console.log('1. the real feed has sent its first update, the mocked list is served, and the update lands before install() detaches the feed');
        await waitFor(`window.__held.length > 0 && !!window.__liveListServed`, 'the feed update and the served list', 10000);
        await waitFor(`!!document.querySelector('#live-sessions-list [data-session-id="sid-race-1"]')`, 'the mocked row drawn from the list', 10000);
        assert.ok(await ev(`window.__letFeedIn() > 0`), 'a feed update was let in');
        await install();
        console.log('2. the mocked agent is still listed');
        await waitFor(`!!document.querySelector('#live-sessions-list [data-session-id="sid-race-1"]')`, 'the mocked row after the late feed update', 3000);
        console.log('PASS harness feed race');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
