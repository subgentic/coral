// The exact set of vendor scripts a cold page loads (#4021). vendor_lazy_browser.test.js pins the loader (once each, retry, no CodeMirror or
// xterm on a cold dashboard); this pins the startup set itself on two views. A cold load of the home page and of an agent's Chat view
// must request only the two small libraries every view renders text with (marked and DOMPurify) among the vendor scripts: no
// CodeMirror (the editor, about 1 MB), no xterm or its addons (the terminal, about 430 KB), no highlight.js (code colouring).
// They are loaded on first use by vendor_loader.js; this fails the moment a page tag or a static import pulls one into startup again.
// Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const { Network } = client;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // A step that takes over 10 s says so on stderr, so a slow run in a loaded batch names what it waited on (#17205: it took 2 s alone and 67 to 180 s in a batch).
    const timed = async (name, work) => { const t = Date.now(); try { return await work; } finally { const d = Date.now() - t; if (d > 10000) console.error(`[slow] ${view} ${name} took ${d} ms`); } };
    let view = '';
    try {
        await Promise.all([Page.enable(), Network.enable()]);
        await Network.setCacheDisabled({ cacheDisabled: true }); // a cold page for every load: nothing comes from the cache, and no disk is cleared (Network.clearBrowserCache blocked for minutes under load, #17205)
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        const seen = [];
        Network.requestWillBeSent(p => { const m = /\/vendor\/([^?#]+)/.exec(p.request.url); if (m) seen.push(m[1]); });
        for (const which of ['home', 'chat']) {
            view = which; seen.length = 0;
            await timed('navigate', Page.navigate({ url: process.env.CORAL_TEST_URL + '/' })); await timed('load', Page.loadEventFired()); await install();
            await timed('coralReady', coralReady(ev));
            if (view === 'chat') {
                await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('vendor-bot', 'A', 6, { sleeping: false }); true`);
                await ev(`window.selectLiveSession('vendor-bot', 'claude', 'vendor-bot-id', 'local'); true`);
                for (let i = 0; i < 100 && !(await ev(`!!document.querySelector('.chat-bubble, .chat-message, [class*="chat-bubble"]')`)); i++) await sleep(50);
            }
            await sleep(500); // sleep-ok: a late lazy load would land within this window; there is no event for "nothing else loads"
            const scripts = [...new Set(seen.filter(f => /\.(js|css)$/.test(f)))].sort();
            assert.deepEqual(scripts, ['marked.min.js', 'purify.min.js'], `${view}: only marked and DOMPurify load at startup, not the editor, the terminal, the highlighter or the shared Inbox renderer (#5818) (saw ${scripts.join(', ')})`);
        }
        console.log('PASS vendor libraries are lazy: the home page and the Chat view load only marked and DOMPurify');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
