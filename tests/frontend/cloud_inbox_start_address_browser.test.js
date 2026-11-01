// #11809 (coral-hub's finding): the Inbox-first start writes /inbox/needs over a bare "/", and the Hub does not serve that path: a reload or a bookmark of it is a 404. On a Hub-served dashboard the start still
// shows the Inbox but keeps the address the Hub served ("/"); a local dashboard keeps its rewrite to /inbox/needs (the control, in the same run). The page is the local server's own with the Hub's boot flag and a
// Hub sign-in answered (as cloud_automations_redirect_browser does it).
process.env.CORAL_KEEP_START = '1'; // this suite is about the start page: the harness does not move a bare / to /agents (#11594)
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;
    const where = () => ev(`({ path: location.pathname, tab: document.body.getAttribute('data-nav-tab'), inbox: !!document.querySelector('#inbox-view:not([hidden])'), boot: JSON.parse(document.getElementById('coral-boot').textContent).mode })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        // the control: a local dashboard rewrites the bare start to /inbox/needs
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await waitFor(`location.pathname === '/inbox/needs'`, 'a local dashboard starts on /inbox/needs', 10000);
        let w = await where();
        assert.deepEqual([w.boot, w.path, w.tab], ['local', '/inbox/needs', 'hub-inbox'], 'local: the Inbox at its folder address ' + JSON.stringify(w));
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
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await waitFor(`!!document.getElementById('coral-boot') && JSON.parse(document.getElementById('coral-boot').textContent).mode === 'cloud'`, "the Hub's boot flag", 10000);
        await waitFor(`!!document.body.getAttribute('data-nav-tab')`, 'a tab is on screen', 10000);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: a rewrite of the address would come right after the start
        w = await where();
        assert.equal(w.path, '/', 'on the Hub the address stays the one the Hub served (a reload of /inbox/needs is a 404 there): ' + JSON.stringify(w));
        assert.equal(w.tab, 'hub-inbox', 'and the Inbox is still the first screen: ' + JSON.stringify(w));
        console.log('PASS the Hub start keeps its address while the Inbox shows');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
