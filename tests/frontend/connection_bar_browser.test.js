// When the server or the network is gone the page says so (#10296, Mobile pass 21: nothing on screen changed until a send failed): a few seconds after the live feed drops and does not come back, a small
// bar in the page's flow (like the alerts offer, #10248) says "No connection, retrying"; when the feed is back it says "Back online" for a moment and goes. At 1280 and 390 px, isolated dev server.
// The real page and the real server (not agent_view_harness, whose page has no live feed of its own).
// The server going away is stood in by the page's WebSocket: the open feed is closed and new ones are refused until the test gives the real one back.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

(async () => {
    const client = await CDP({ port: parseInt(process.env.CDP_PORT || '9222', 10) });
    const { Page, Runtime, Emulation } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const ev = async x => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const { waitFor, coralReady, settle } = require('./helpers/wait').bind(ev);
    try {
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
            const STATE = `import((window.__coralStatic || '/static/') + 'state.js').then(m => m.state)`;
            await waitFor(`${STATE}.then(s => !!s.coralWs && s.coralWs.readyState === 1)`, `${w}: the feed is open`, { timeout: 8000 });
            const bar = () => ev(`(() => { const b = document.getElementById('connection-bar'); if (!b) return null; const r = b.getBoundingClientRect(), top = document.querySelector('header.top-bar');
                return { text: b.textContent.replace(/\\s+/g, ' ').trim(), role: b.getAttribute('role'), inFlow: getComputedStyle(b).position !== 'fixed' && getComputedStyle(b).position !== 'absolute', over: Math.round(document.documentElement.scrollWidth - innerWidth),
                    belowTop: !top || r.top >= top.getBoundingClientRect().bottom - 1, right: Math.round(r.right), shown: r.height > 0 }; })()`);
            assert.equal(await bar(), null, `${w}: with the feed up there is no bar`);
            // the server goes: the open feed closes, new ones are refused
            await ev(`(() => { window.__realWS = window.WebSocket; window.WebSocket = class { constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 3; if (this.onclose) this.onclose({ code: 1006, reason: '' }); for (const f of (this._l || {}).close || []) f({ code: 1006 }); }, 0); } addEventListener(t, f) { (this._l = this._l || {})[t] = [...((this._l || {})[t] || []), f]; } send() {} close() {} }; return import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.coralWs.close(); return true; }); })()`);
            await new Promise(r => setTimeout(r, 1000)); // sleep-ok: "after a few seconds": one second in, nothing is said yet
            assert.equal(await bar(), null, `${w}: a blip of a second says nothing`);
            await waitFor(`!!document.getElementById('connection-bar')`, `${w}: the bar after a few seconds`, { timeout: 9000 });
            await settle(300);
            const b = await bar();
            assert.equal(b.text, 'No connection, retrying', `${w}: the words: ${JSON.stringify(b)}`);
            assert.ok(b.inFlow && b.belowTop && b.shown && b.over <= 0 && b.right <= w, `${w}: in the page's flow, under the top bar, inside the screen: ${JSON.stringify(b)}`);
            assert.equal(b.role, 'status', `${w}: a status, so a screen reader hears it`);
            // the server is back: the next retry connects
            await ev(`window.WebSocket = window.__realWS; true`);
            await waitFor(`(document.getElementById('connection-bar') || {}).textContent === 'Back online' || !document.getElementById('connection-bar')`, `${w}: back online`, { timeout: 20000 });
            if (await bar()) assert.equal((await bar()).text, 'Back online', `${w}: says Back online`);
            await waitFor(`!document.getElementById('connection-bar')`, `${w}: Back online goes by itself`, { timeout: 9000 });
            // the browser goes offline (DevTools' Offline keeps the open socket): the same bar after the same few seconds, and Back online after
            await client.Network.enable(); await client.Network.emulateNetworkConditions({ offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
            await new Promise(r => setTimeout(r, 1000)); // sleep-ok: one second in, nothing is said yet
            assert.equal(await bar(), null, `${w}: offline for a second says nothing`);
            await waitFor(`!!document.getElementById('connection-bar')`, `${w}: the bar after the browser went offline`, { timeout: 9000 });
            assert.equal((await bar()).text, 'No connection, retrying', `${w}: offline says the same words`);
            await client.Network.emulateNetworkConditions({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
            await waitFor(`(document.getElementById('connection-bar') || {}).textContent === 'Back online' || !document.getElementById('connection-bar')`, `${w}: back online after offline`, { timeout: 10000 });
            await waitFor(`!document.getElementById('connection-bar')`, `${w}: Back online goes by itself after offline`, { timeout: 9000 });
            console.log(`PASS ${w}: the page says when the connection is gone and when it is back`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
