// #19571: Automations addresses remain available in cloud with the approved
// owner-only, metadata-allow-list server prerequisite. Local routing is unchanged.
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;
    const ADDRESSES = ['/jobs', '/workflows', '/workflows/4', '/automations', '/automations/jobs', '/automations/jobs/3', '/automations/workflows', '/automations/workflows/2/runs/5'];
    // the Automations screen is its folders (Jobs, Workflows) drawn in the sidebar
    const where = () => ev(`({ path: location.pathname, tab: document.body.getAttribute('data-nav-tab'), screen: [...document.querySelectorAll('#automations-nav-list .view-list-item')].some(b => b.getClientRects().length > 0), boot: JSON.parse(document.getElementById('coral-boot').textContent).mode })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        // the control: a local dashboard shows the screen for /jobs
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/jobs' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        // the path is rewritten before the folders are drawn: wait for both, or a loaded machine reads the screen too early (#19967)
        await waitFor(`location.pathname.startsWith('/automations') && [...document.querySelectorAll('#automations-nav-list .view-list-item')].some(b => b.getClientRects().length > 0)`, 'a local dashboard rewrites /jobs to Automations and draws its folders', 10000);
        let w = await where();
        assert.deepEqual([w.boot, w.tab, w.screen], ['local', 'automations', true], 'local: the Automations screen, its folders drawn (so the check that none is drawn on the Hub is not dead) ' + JSON.stringify(w));
        // the Hub
        await Network.enable(); await Network.setBypassServiceWorker({ bypass: true });
        await Fetch.enable({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }, { urlPattern: '*/auth/session', requestStage: 'Request' }] });
        safePaused(client, async e => {
            if (e.request.url.endsWith('/auth/session')) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ authenticated: true, email: 'qa@example.com', csrf: 'qa-csrf' })).toString('base64') });
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace(/"mode":\s*"local"/, '"mode":"cloud"');
            return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name)), body: Buffer.from(html).toString('base64') });
        });
        for (const url of ADDRESSES) {
            await Page.navigate({ url: process.env.CORAL_TEST_URL + url }); await Page.loadEventFired(); await install();
            await waitFor(`!!document.getElementById('coral-boot') && JSON.parse(document.getElementById('coral-boot').textContent).mode === 'cloud'`, `${url}: the Hub's boot flag`, 10000);
            // wait for the state asserted below, not for "some tab": the startup default tab is set first and the route
            // (its path rewrite and the folders drawn in the sidebar) a moment later, so a loaded machine read the default (#19967)
            await waitFor(`document.body.getAttribute('data-nav-tab') === 'automations' && location.pathname.startsWith('/automations') && [...document.querySelectorAll('#automations-nav-list .view-list-item')].some(b => b.getClientRects().length > 0)`, `${url}: the Automations screen is on screen`, 10000);
            w = await where();
            assert.ok(w.tab === 'automations' && w.screen && w.path.startsWith('/automations'), `${url} opens read-only Automations in cloud: ` + JSON.stringify(w));
        }
        console.log('PASS the Hub opens ' + ADDRESSES.length + ' read-only Automations addresses');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
