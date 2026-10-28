// The Hub does not serve Automations (#9711, coral-hub's fact of 00:07Z): on a Hub-served dashboard typing /jobs, /workflows or any /automations/** address lands on Agents, never on the Automations
// screen (its New job, Build with Agent, New workflow, run controls). The page is the local server's own with the Hub's boot flag and a Hub sign-in answered (as team_presets_hub_browser does it);
// a local dashboard keeps the screen (the control, in the same run).
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;
    const ADDRESSES = ['/jobs', '/workflows', '/workflows/4', '/automations', '/automations/jobs', '/automations/jobs/3', '/automations/workflows', '/automations/workflows/2/runs/5'];
    const where = () => ev(`({ path: location.pathname, tab: document.body.getAttribute('data-nav-tab'), screen: !!document.getElementById('automations-view') && document.getElementById('automations-view').getClientRects().length > 0, boot: JSON.parse(document.getElementById('coral-boot').textContent).mode })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        // the control: a local dashboard shows the screen for /jobs
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/jobs' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`location.pathname.startsWith('/automations')`, 'a local dashboard rewrites /jobs to Automations', 10000);
        let w = await where();
        assert.deepEqual([w.boot, w.tab], ['local', 'automations'], 'local: the Automations screen ' + JSON.stringify(w));
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
            await waitFor(`!!document.body.getAttribute('data-nav-tab')`, `${url}: a tab is on screen`, 10000);
            w = await where();
            assert.ok(w.tab === 'agents' && !w.screen && !w.path.startsWith('/automations') && !w.path.startsWith('/jobs') && !w.path.startsWith('/workflows'), `${url} on the Hub lands on Agents, not on the Automations screen: ` + JSON.stringify(w));
        }
        console.log('PASS the Hub redirects ' + ADDRESSES.length + ' Automations addresses to Agents');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
