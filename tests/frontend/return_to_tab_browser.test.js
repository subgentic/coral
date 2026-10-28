// Coming back to the page refreshes the open agent's chat at once and says what it is doing (#10068, desktop #10063 and mobile #10089): "Loading chat…" while it reads it again, "Reconnecting…" when the
// feed socket was closed meanwhile (and the feed is reconnected now, not at the next backoff tick), nothing in the way once it is done, and nothing at all for a quick refresh. Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__m.add('alpha', 'A', 6, { sleeping: false }); true`);
        await ev(`window.selectLiveSession('alpha', 'claude', 'alpha-id'); true`);
        await waitFor(`!!document.getElementById('live-history-messages')`, 'the chat');
        // The page can be hidden by the test, and the chat read can be made slow.
        await ev(`window.__hidden = false; Object.defineProperty(document, 'hidden', { configurable: true, get: () => !!window.__hidden });
            window.__slow = 0; window.__reads = 0; const real = window.fetch;
            window.fetch = function (u, o) { const url = String(u); if (/\\/(history|chat)\\b/.test(url) && !/\\/send/.test(url)) { window.__reads++; if (window.__slow) return new Promise(r => setTimeout(() => r(real.call(this, u, o)), window.__slow)); } return real.call(this, u, o); }; true`);
        const note = () => ev(`(() => { const n = document.getElementById('chat-return-note'); return n && !n.hidden ? n.textContent : ''; })()`);
        const comeBack = () => ev(`window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); true`);

        // 1. A slow read: the chat is read again at once and the note says so, then goes.
        await ev(`window.__slow = 1500; window.__reads = 0; true`);
        await ev(`(async () => { const ws = (await import(${MOD} + 'state.js')).state.coralWs; return !!ws; })()`);
        await comeBack();
        await waitFor(`window.__reads >= 1`, 'the chat read again on return');
        await waitFor(`!!document.getElementById('chat-return-note') && !document.getElementById('chat-return-note').hidden`, 'the note while it loads');
        const text = await note();
        assert.ok(text === 'Loading chat…' || text === 'Reconnecting…', 'the note says what is happening: ' + text);
        await waitFor(`document.getElementById('chat-return-note').hidden === true`, 'the note gone once the chat is read', { timeout: 15000 });
        assert.equal(await note(), '');

        // 2. A quick read is not announced.
        await ev(`window.__slow = 0; true`);
        await comeBack();
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: a quick read must not flash a note; there is nothing to wait on when it must not appear
        assert.equal(await note(), '', 'no flash for a quick refresh');

        // 3. The feed socket was closed while the page was away: the note says Reconnecting…, and the feed is reconnected now.
        await ev(`(async () => { const { state } = await import(${MOD} + 'state.js'); window.__sockets = 0; const W = window.WebSocket;
            window.WebSocket = function (u, p) { window.__sockets++; return new W(u, p); }; window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
            const ws = state.coralWs; if (ws) { ws.onclose = null; try { ws.close(); } catch {} } state.coralWs = { readyState: 3, close() {} }; window.__slow = 1500; return true; })()`);
        await comeBack();
        await waitFor(`window.__sockets >= 1`, 'a new feed socket opened at once');
        await waitFor(`(() => { const n = document.getElementById('chat-return-note'); return !!n && !n.hidden && n.textContent === 'Reconnecting…'; })()`, 'the note says Reconnecting…');
        await waitFor(`document.getElementById('chat-return-note').hidden === true`, 'and goes when the chat is read', { timeout: 15000 });

        // 4. Other ways back count: a page restored from the back-forward cache, and the network coming back.
        await ev(`window.__slow = 1500; window.__reads = 0; true`);
        await ev(`window.dispatchEvent(new Event('online')); true`);
        await waitFor(`window.__reads >= 1`, 'the chat read again when the network is back');
        await waitFor(`document.getElementById('chat-return-note').hidden === true`, 'and the note goes', { timeout: 15000 });
        console.log('PASS coming back refreshes the open chat at once, with Loading chat… or Reconnecting… and nothing left behind');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
