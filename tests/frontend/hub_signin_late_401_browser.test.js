// A late 401 on a page that is already navigating away must not replace the navigation (#12970, coral-hub's report: 2 runs in 28 under load). A signed-in page is still loading, its cookies go, the browser opens a deep
// link (/agents/@<server>/<session>/files) and the Hub answers 302 /signin?next=<the deep link>; a moment later the OLD page's fetch gets a 401 and cloud.js sent location.replace(signInUrl()), whose next= is the OLD
// address, without /files. That replace won. Here the deep link's navigation is held in flight, the old page's request is answered 401 meanwhile, and the Hub's 302 is let through after: the page must land on the deep
// link's sign-in. A 401 on a page that is NOT leaving must still go to sign-in (the other half, so the guard is not "never redirect").
process.env.CORAL_KEEP_START = '1';
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');

const J = [{ name: 'Content-Type', value: 'application/json' }];
const b64 = s => Buffer.from(s).toString('base64');
const T = (what, p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('stuck: ' + what)), 8000))]); // sleep-ok: a bound so a stuck call names itself
const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: ordering the late answer after the navigation began

(async () => {
    const { client, Page, PRELOAD } = await connect();
    const { Fetch, Network } = client;
    const Runtime = { evaluate: a => T('evaluate ' + a.expression.slice(0, 40), client.Runtime.evaluate(a)) };
    const signins = [];
    const heldApi = [];
    const navs = [];
    let heldDoc = null;
    let heldSignin = null; // the Hub's sign-in page, held while the late answer arrives
    let holdSignin = false;
    let holdApi = false;
    let expire = false;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Network.enable(); await Network.setBypassServiceWorker({ bypass: true });
        Network.requestWillBeSent(p => { if (/\/signin(\?|$)/.test(p.request.url)) signins.push(p.request.url.replace(/^https?:\/\/[^/]+/, '')); });
        await Fetch.enable({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }, { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }, { urlPattern: '*/auth/session', requestStage: 'Request' }, { urlPattern: '*/api/*', requestStage: 'Request' }] });
        safePaused(client, async e => {
            const url = e.request.url;
            const request = e.responseStatusCode === undefined && e.responseErrorReason === undefined;
            if (url.endsWith('/auth/session')) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: J, body: b64(JSON.stringify({ authenticated: true, csrf: 'x' })) });
            if (/\/api\/__navlog/.test(url)) { navs.push(decodeURIComponent(url.split('?u=')[1])); return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: J, body: b64('{}') }); } // what the old page reports of its own navigations
            if (/\/api\//.test(url)) {
                if (holdApi) { heldApi.push(e.requestId); return; }
                if (expire) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 401, responseHeaders: J, body: b64(JSON.stringify({ error: 'unauthorized' })) });
                return Fetch.continueRequest({ requestId: e.requestId });
            }
            if (/\/signin/.test(url)) { if (holdSignin && /files/.test(decodeURIComponent(url)) && !heldSignin) { heldSignin = e.requestId; return; } return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: b64('<!doctype html><title>signin</title>') }); }
            if (request) { if (/\/files$/.test(url)) { heldDoc = e.requestId; return; } return Fetch.continueRequest({ requestId: e.requestId }); } // the deep link's navigation is held in flight
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace(/"mode":\s*"local"/, '"mode":"cloud"');
            return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name)), body: b64(html) });
        });
        const here = async () => (await Runtime.evaluate({ expression: 'location.pathname + location.search', returnByValue: true })).result.value;
        const open = async () => { signins.length = 0; navs.length = 0; heldApi.length = 0; heldDoc = null; holdApi = false; expire = false; await Page.navigate({ url: process.env.CORAL_TEST_URL + '/agents/@srv/abc123' }); await sleep(600); }; // sleep-ok: the page settles after its start
        const deep = '/agents/@srv/abc123/files';
        const want = '/signin?next=' + encodeURIComponent(deep);

        // 1: the late 401 while the browser is already on its way to the deep link
        await open();
        holdApi = true;
        await Runtime.evaluate({ expression: "navigation.addEventListener('navigate', e => { fetch('/api/__navlog?u=' + encodeURIComponent(e.destination.url)).catch(() => {}); }); true" }); // every navigation the old page itself starts, even one the browser then ignores
        await Runtime.evaluate({ expression: "fetch('/api/settings').catch(() => {}); true" });
        const t0 = Date.now(); while (!heldApi.length && Date.now() - t0 < 5000) await sleep(20);
        assert.equal(heldApi.length, 1, 'precondition: the old page has a request in flight');
        Page.navigate({ url: process.env.CORAL_TEST_URL + deep }).catch(() => {});
        const t1 = Date.now(); while (!heldDoc && Date.now() - t1 < 5000) await sleep(20);
        assert.ok(heldDoc, 'precondition: the deep link navigation is in flight');
        holdSignin = true;
        await T('fulfill heldDoc', Fetch.fulfillRequest({ requestId: heldDoc, responseCode: 302, responseHeaders: [{ name: 'Location', value: want }] })); // the Hub's answer to the deep link: its sign-in is now what the browser is loading
        const ts = Date.now(); while (!heldSignin && Date.now() - ts < 5000) await sleep(20);
        assert.ok(heldSignin, 'precondition: the Hub\'s sign-in is in flight');
        await T('fulfill heldApi[0]', Fetch.fulfillRequest({ requestId: heldApi[0], responseCode: 401, responseHeaders: J, body: b64(JSON.stringify({ error: 'unauthorized' })) })); // the old page's late answer, nine milliseconds after
        await sleep(500); // sleep-ok: the window in which the old page would have redirected
        assert.deepEqual(navs, [], 'the old page started no navigation of its own after the browser left it: ' + JSON.stringify(navs));
        await T('fulfill heldSignin', Fetch.fulfillRequest({ requestId: heldSignin, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: b64('<!doctype html><title>signin</title>') }));
        const t2 = Date.now(); while (!signins.includes(want) && Date.now() - t2 < 3000) await sleep(50);
        await sleep(600); // sleep-ok: after the sign-in answer, nothing else may navigate
        assert.ok(!signins.includes('/signin?next=' + encodeURIComponent('/agents/@srv/abc123')), 'the old page did not send its own sign-in: ' + JSON.stringify(signins));
        assert.equal(await here(), want, 'the page lands on the deep link\'s sign-in, got ' + await here());

        // 2: a 401 on a page that is staying still goes to sign-in
        await open();
        expire = true;
        await Runtime.evaluate({ expression: "fetch('/api/settings').catch(() => {}); true" });
        const t3 = Date.now(); while (!signins.length && Date.now() - t3 < 8000) await sleep(50);
        assert.deepEqual(signins.slice(0, 1), ['/signin?next=' + encodeURIComponent('/agents/@srv/abc123')], 'a page that stays still is sent to sign-in: ' + JSON.stringify(signins));
        console.log('PASS a late 401 does not replace a navigation in flight, and a still page is sent to sign-in');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
