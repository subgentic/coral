// #13087 (QA Reviewer 2's INFO 6): a page that is never quiet (steady polling under a second apart) still gets the Home goal card's teams read, at most about 5 s after the card is drawn.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { window.__reads = []; const real = window.fetch;
            window.fetch = (u, o) => { const p = new URL(String(u), location.href).pathname;
                if (p === '/api/board/projects') { window.__reads.push(performance.now()); return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return real(u, o); }; })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__steady = setInterval(() => fetch('/static/theme_init.js?poll=' + Math.random(), { cache: 'no-store' }), 400); true`); // a request every 400 ms: never a quiet second
        await waitFor(`window.__reads.length >= 1`, 'the teams read is made although the page is never quiet', 9000);
        const at = await ev(`window.__reads[0]`);
        console.log(`teams read at ${Math.round(at)} ms with a request every 400 ms`);
        assert.ok(at < 7000, `the read comes at most about 5 s after the card is drawn: ${Math.round(at)} ms`);
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
