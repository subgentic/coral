// Hub 3.0 Queue (#19568, coral-hub fleet-views §7.1.3, C7): the Queue's 5 s read stops while the browser tab is hidden (a hidden tab sends no /api/resources for 15 s) and reads once, at once, when the tab is
// shown again; the poll runs again after. The tab being hidden is simulated by document.hidden / visibilitychange. /api/resources is counted in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const STUB = `(() => { const real = window.fetch; window.__reads = 0; window.__hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
    window.fetch = (u, o) => { const s = String(u), m = (o && o.method) || 'GET';
        if (m === 'GET' && /\\/api\\/resources$/.test(s)) { window.__reads++; return Promise.resolve(new Response(JSON.stringify({ resources: [{ name: 'mac-heavy', slots: 1, holders: [], queue: [] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
        return real(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the test is about 15 s of silence
    const setHidden = h => ev(`window.__hidden = ${h}; document.dispatchEvent(new Event('visibilitychange')); true`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`localStorage.clear(); history.pushState(null, '', '/queue'); window.dispatchEvent(new PopStateEvent('popstate')); true`);
        await waitFor(`window.__reads >= 1 && !!document.getElementById('queue-tab-body')`, 'the Queue tab read once', 10000);
        await waitFor(`window.__reads >= 2`, 'the 5 s poll runs while the tab is shown', 9000);
        await setHidden(true); await sleep(300); // sleep-ok: a request would be sent within this time
        const before = await ev('window.__reads');
        await sleep(15000); // sleep-ok: the check is 15 s of silence
        assert.equal(await ev('window.__reads'), before, 'a hidden tab sends no /api/resources for 15 s');
        await setHidden(false);
        await waitFor(`window.__reads === ${before + 1}`, 'one read at once when the tab is shown', 1500);
        await sleep(300); // sleep-ok: a request would be sent within this time
        assert.equal(await ev('window.__reads'), before + 1, 'exactly one read on show');
        await waitFor(`window.__reads >= ${before + 2}`, 'the poll runs again after', 9000);
        console.log('PASS Queue read stops while the tab is hidden (15 s, no /api/resources), one read on show, the poll resumes');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
