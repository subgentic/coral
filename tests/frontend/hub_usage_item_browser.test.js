// The Usage item in the Coral Hub's account menu (#11018, coral-hub's ask): a plain link to the hub's /usage (the rolled-up Analytics; the Analytics tab is local-only), after Saved for later, shown only where GET /api/account
// says analytics_tab === true (a strict boolean, as artifacts_frame is read). False, a missing field (the hub leaves it out for an account that does not have it), a 404, an unreadable answer, the string "true" or the number 1:
// hidden. A local Coral has no account menu, so no item. Served as the hub would serve the dashboard (cloud boot flag, stubbed session, servers and live list), against the isolated dev server; the account is stood in.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Network, Fetch, Emulation } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const { waitFor } = require('./helpers/wait').bind(ev);
    let cloud = true;
    let account = { status: 200, body: { analytics_tab: true } }; // what GET /api/account answers: {status, body} (body a string for an unreadable one)
    try {
        await Promise.all([Page.enable(), Runtime.enable(), Network.enable()]);
        await Network.setCacheDisabled({ cacheDisabled: true });
        await Fetch.enable({ patterns: [{ urlPattern: `${BASE}/`, resourceType: 'Document', requestStage: 'Response' }, { urlPattern: `${BASE}/auth/session`, requestStage: 'Request' }, { urlPattern: `${BASE}/api/account*`, requestStage: 'Request' },
            { urlPattern: `${BASE}/api/servers*`, requestStage: 'Request' }, { urlPattern: `${BASE}/api/sessions/live*`, requestStage: 'Request' }, { urlPattern: `${BASE}/artifacts`, requestStage: 'Request' }] });
        const reply = (id, status, body, type = 'application/json') => Fetch.fulfillRequest({ requestId: id, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: type }], body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64') });
        safePaused(client, async e => {
            const u = e.request.url;
            if (u.endsWith('/auth/session')) return reply(e.requestId, 200, { authenticated: true, email: 'tester@example.invalid', csrf: 'x' });
            if (/\/api\/account(\?|$)/.test(u)) return reply(e.requestId, account.status, account.body);
            if (/\/api\/servers(\?|$)/.test(u)) return reply(e.requestId, 200, { servers: [] });
            if (/\/api\/sessions\/live(\?|$)/.test(u)) return reply(e.requestId, 200, cloud ? { sessions: [], servers: [] } : []);
            if (u === `${BASE}/artifacts`) return reply(e.requestId, 200, '<!doctype html><title>Artifacts (stand-in)</title><p>Artifacts</p>', 'text/html');
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            let html = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
            if (cloud) html = html.replace('"mode":"local"', '"mode":"cloud"');
            const headers = (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name));
            await Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(html).toString('base64') });
        });
        const open = async (width = 1280, mobile = false) => {
            await Emulation.setDeviceMetricsOverride({ width, height: 800, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`document.body.classList.contains('cloud-mode') === ${cloud} && !!document.querySelector('.top-nav-tabs')`, 'the dashboard', { timeout: 15000 });
            await new Promise(r => setTimeout(r, 700)); // sleep-ok: the account answer lands after the page starts
        };
        const usage = () => ev(`(() => { const a = document.getElementById('cloud-account-usage'); document.querySelector('.cloud-account-btn') && document.querySelector('.cloud-account-btn').click(); return a ? { shown: !a.hidden && a.getClientRects().length > 0, href: a.getAttribute('href'), tag: a.tagName, text: a.textContent.trim(), role: a.getAttribute('role'), after: a.previousElementSibling && a.previousElementSibling.textContent.trim() } : null; })()`);
        console.log('1. analytics_tab: true: a plain link to /usage, after Saved for later');
        await open();
        const t = await usage();
        assert.deepEqual(t, { shown: true, href: '/usage', tag: 'A', text: 'Usage', role: 'menuitem', after: 'Saved for later' });
        console.log('2. false, a missing field, a 404, unreadable, a string, a number: hidden');
        for (const [what, a] of [['false', { status: 200, body: { analytics_tab: false } }], ['missing', { status: 200, body: { artifacts_tab: true } }], ['404', { status: 404, body: { error: 'x' } }], ['unreadable', { status: 200, body: 'not json' }], ['string true', { status: 200, body: { analytics_tab: 'true' } }], ['number 1', { status: 200, body: { analytics_tab: 1 } }]]) {
            account = a; await open();
            assert.equal(await usage(), null, what + ': no Usage item');
        }
        console.log('3. A local Coral: no account menu, no item');
        account = { status: 200, body: { analytics_tab: true } };
        cloud = false;
        await open();
        assert.equal(await ev(`!!document.getElementById('cloud-account-usage')`), false);
        console.log('   ✓');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
