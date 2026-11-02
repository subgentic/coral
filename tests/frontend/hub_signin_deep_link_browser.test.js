// The Hub's sign-in brings a deep link back whole (#12432, QA Engineer's SHOULD): through a browser, on a Hub-served dashboard (the local server's page with the Hub's boot flag, as cloud_inbox_start_address_browser does it),
// a session check that answers "signed out" a moment after the page started sends it to /signin?next=<where it was opened>. The app has shortened /agents/@<server>/<session>/files by then (the agent is not known), so
// next= built from the address on screen lost the tab; it is the address the page was opened at now. Reverting cloud.js's signInUrl fails this.
process.env.CORAL_KEEP_START = '1';
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;
    const signins = [];
    let expireAt = Infinity;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Network.enable(); await Network.setBypassServiceWorker({ bypass: true });
        Network.requestWillBeSent(p => { if (/\/signin(\?|$)/.test(p.request.url)) signins.push(p.request.url.replace(/^https?:\/\/[^/]+/, '')); });
        await Fetch.enable({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }, { urlPattern: '*/auth/session', requestStage: 'Request' }, { urlPattern: '*/api/*', requestStage: 'Request' }] });
        safePaused(client, async e => {
            if (e.request.url.endsWith('/auth/session')) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ authenticated: true, csrf: 'x' })).toString('base64') });
            if (/\/api\//.test(e.request.url) && Date.now() > expireAt) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 401, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'unauthorized' })).toString('base64') }); // the session ends a moment after the app has started: the next /api call is answered 401 and cloud.js's fetch wrapper sends the page to the Hub's sign-in
            if (/\/signin/.test(e.request.url)) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from('<!doctype html><title>signin</title>').toString('base64') });
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace(/"mode":\s*"local"/, '"mode":"cloud"');
            return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name)), body: Buffer.from(html).toString('base64') });
        });
        for (const path of ['/agents/@srv/abc123/files', '/agents/@srv/abc123/board']) {
            signins.length = 0; expireAt = Infinity;
            await Page.navigate({ url: process.env.CORAL_TEST_URL + path });
            // the app shortens an address it cannot show yet (a real agent that has not loaded; here the shortening is done for it, so the test does not depend on the page's load order): before the session check answers
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: after the app's own start, before the delayed session answer
            const short = path.replace(/\/(files|board)$/, '');
            await client.Runtime.evaluate({ expression: `history.replaceState(history.state, '', ${JSON.stringify(short)}); true` });
            assert.equal((await client.Runtime.evaluate({ expression: 'location.pathname', returnByValue: true })).result.value, short, 'precondition: the address on screen is the shortened one');
            expireAt = 0; await client.Runtime.evaluate({ expression: "fetch('/api/settings').catch(() => {}); true" }); // the session has ended: any /api call the page makes next is answered 401, and cloud.js sends the page to the Hub's sign-in
            const t0 = Date.now(); while (!signins.length && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 100)); // sleep-ok: a bounded wait for the redirect to the Hub's sign-in
            assert.deepEqual(signins.slice(0, 1), ['/signin?next=' + encodeURIComponent(path)], `${path}: the Hub's sign-in is sent where the page was opened: ` + JSON.stringify(signins));
        }
        console.log('PASS the Hub sign-in next= is the address the page was opened at');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
