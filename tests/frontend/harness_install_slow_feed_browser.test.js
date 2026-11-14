// The harness's install() detaches the page's real feed (the mocked agents must not be replaced by the test
// server's empty list). On a slow runner the feed socket can still be connecting at that moment: closing a
// connecting socket never fires 'open', so the feed was never marked ready, nothing reconnected (the harness
// stops the reconnect) and window.__coralReady timed out 30 s later with feed:false (#15978, the Windows strict
// a11y_dashboard flake). install() must let a connecting feed open before it detaches it.
const assert = require('node:assert');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

// A page whose first /ws/coral handshake takes 6 s, as a loaded Windows runner's can: the socket reads
// CONNECTING (0) until then, and a close() while it does suppresses the 'open' event, as a browser does.
const SLOW_FEED = `(() => {
    const Real = window.WebSocket, HOLD = 6000;
    function W(u, p) {
        const real = p === undefined ? new Real(u) : new Real(u, p);
        if (!/\\/ws\\/coral/.test(String(u))) return real;
        let up = false, closed = false;
        const opens = [];
        real.addEventListener('open', () => setTimeout(() => { if (closed) return; up = true; for (const f of opens) f.call(real, new Event('open')); }, HOLD));
        const proxy = new Proxy(real, {
            get(t, k) {
                if (k === 'readyState') return up ? t.readyState : 0;
                if (k === 'addEventListener') return (type, f, o) => (type === 'open' ? opens.push(f) : t.addEventListener(type, f, o));
                if (k === 'close') return (...a) => { closed = true; return t.close(...a); };
                const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
            },
            set(t, k, v) { t[k] = v; return true; },
        });
        return proxy;
    }
    W.prototype = Real.prototype; W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3;
    window.WebSocket = W;
})();`;

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: SLOW_FEED });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' });
        await Page.loadEventFired();
        await install();
        const ok = await ev(`Promise.race([window.__coralReady.then(() => true), new Promise(r => setTimeout(() => r(false), 15000))])`);
        const parts = await ev(`window.__coralReady.parts`);
        assert.ok(ok, `the app became ready after install() detached a feed still connecting (parts: ${JSON.stringify(parts)})`);
        console.log('install() lets a connecting feed open: window.__coralReady resolved, feed ready');
    } finally {
        await client.close();
    }
})().catch(err => { console.error(err); process.exit(1); });
