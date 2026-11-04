// #13087 follow-up (QA Reviewer 2's INFO): the Home goal card's teams read is made once the page's own requests have been quiet, not a fixed time after the card is drawn. A start request that comes late (a slow
// runner, a slow answer) holds the read back: it is never made within 900 ms of another request finishing.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // two requests of the page's own that finish late (0.7 s and 1.5 s in: a slow runner, a lazy module): the teams read is stamped when it is made
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { window.__reads = []; const real = window.fetch;
            window.fetch = (u, o) => { const p = new URL(String(u), location.href).pathname;
                if (p === '/api/board/projects') { window.__reads.push(performance.now()); return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return real(u, o); };
            })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`for (const at of [350, 1150]) setTimeout(() => fetch('/static/theme_init.js?late=' + at, { cache: 'no-store' }), at); true`); // two requests of the page's own that finish late
        await waitFor(`window.__reads.length >= 1`, 'the teams read is made', 20000);
        const at = await ev(`window.__reads[0]`);
        const lastBefore = await ev(`(() => { const t = window.__reads[0]; return Math.max(0, ...performance.getEntriesByType('resource').filter(e => e.responseEnd <= t && !/\\/(api\\/board\\/projects|home_goal\\.js)/.test(e.name)).map(e => e.responseEnd)); })()`);
        console.log(`teams read at ${Math.round(at)} ms; the last other request (the card's own module aside) finished at ${Math.round(lastBefore)} ms`);
        assert.ok(at - lastBefore >= 900, `the teams read waits for the page's requests to go quiet: ${Math.round(at - lastBefore)} ms after the last one`);
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
