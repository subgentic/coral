// The Hub's account menu draws its entries from GET /api/account's `nav`, BY KEY, from Coral's own table (#11106, the Hub's ask): nav [goals, nope, usage] gives Goals then Usage and nothing for `nope`; no `nav` (an older Hub), a failed read and an
// answer that is not an object give today's links (Account, Saved for later); an older Hub with analytics_tab and no `nav` keeps Usage after Saved for later (#11018). Servers is first and Sign out last. The page asks /api/account ONCE (the menu, the
// Artifacts tab and the team-link flag share the read). The menu keyboard: the focus lands on the first item, Down/Up wrap, Home/End, Escape gives the focus back to the button. Served as the hub serves it (boot flag "cloud").
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Network, Fetch, Emulation, Input } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const { waitFor } = require('./helpers/wait').bind(ev);
    let account = { status: 200, body: {} }, accountReads = 0;
    const key = async (k, vk) => { for (const type of ['keyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: k, code: k, windowsVirtualKeyCode: vk }); };
    try {
        await Promise.all([Page.enable(), Runtime.enable(), Network.enable()]);
        await Network.setCacheDisabled({ cacheDisabled: true });
        await Fetch.enable({ patterns: [{ urlPattern: `${BASE}/`, resourceType: 'Document', requestStage: 'Response' }, { urlPattern: `${BASE}/auth/session`, requestStage: 'Request' }, { urlPattern: `${BASE}/api/account*`, requestStage: 'Request' },
            { urlPattern: `${BASE}/api/servers*`, requestStage: 'Request' }, { urlPattern: `${BASE}/api/sessions/live*`, requestStage: 'Request' }] });
        const json = (id, status, body) => Fetch.fulfillRequest({ requestId: id, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64') });
        safePaused(client, async e => {
            const u = e.request.url;
            if (u.endsWith('/auth/session')) return json(e.requestId, 200, { authenticated: true, email: 'tester@example.com', csrf: 'x' });
            if (/\/api\/account(\?|$)/.test(u)) { accountReads++; return json(e.requestId, account.status, account.body); }
            if (/\/api\/servers(\?|$)/.test(u)) return json(e.requestId, 200, { servers: [{ id: 'm1', label: 'Laptop', status: 'online' }] });
            if (/\/api\/sessions\/live(\?|$)/.test(u)) return json(e.requestId, 200, { sessions: [], servers: [] });
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace('"mode":"local"', '"mode":"cloud"');
            await Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name)), body: Buffer.from(html).toString('base64') });
        });
        const load = async (acct) => {
            account = acct; accountReads = 0;
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 756, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`document.body.classList.contains('cloud-mode') && !!document.getElementById('cloud-account-menu')`, 'the account menu', { timeout: 15000 });
        };
        const entries = () => ev(`[...document.querySelectorAll('#cloud-account-menu [role=menuitem]')].map(e => [e.textContent.trim(), e.getAttribute('href')])`);
        // 1. nav [goals, nope, usage]
        await load({ status: 200, body: { nav: [{ key: 'goals', label: 'Evil', path: 'https://evil.example/' }, { key: 'nope' }, { key: 'usage' }], artifacts_frame: true, team_link_dialog: true } });
        await waitFor(`[...document.querySelectorAll('#cloud-account-menu [role=menuitem]')].some(e => e.textContent.trim() === 'Usage')`, 'Usage from the nav', 6000);
        assert.deepEqual(await entries(), [['Servers', null], ['Goals', '/goals'], ['Usage', '/usage'], ['Sign out', null]], 'Servers, then Goals and Usage from Coral\'s table (nothing for nope, nothing of the response\'s label or path), Sign out last');
        assert.equal(accountReads, 1, 'one request to /api/account on load (the menu, the Artifacts tab and the team-link flag share it)');
        assert.equal(await ev(`!document.getElementById('nav-tab-artifacts').hidden`), true, 'the Artifacts tab used the same answer (artifacts_frame)');
        // 2. the menu keyboard
        await ev(`document.querySelector('.cloud-account-btn').focus(); true`);
        await key('ArrowDown', 40);
        await waitFor(`!document.getElementById('cloud-account-menu').hidden && document.activeElement === document.querySelector('#cloud-account-menu [role=menuitem]')`, 'ArrowDown on the button opens the menu on its first item', 4000);
        const act = () => ev(`document.activeElement.textContent.trim()`);
        await key('ArrowDown', 40); assert.equal(await act(), 'Goals', 'Down: the next item');
        await key('End', 35); assert.equal(await act(), 'Sign out', 'End: the last');
        await key('ArrowDown', 40); assert.equal(await act(), 'Servers', 'Down from the last wraps to the first');
        await key('ArrowUp', 38); assert.equal(await act(), 'Sign out', 'Up from the first wraps to the last');
        await key('Home', 36); assert.equal(await act(), 'Servers', 'Home: the first');
        await key('Escape', 27);
        await waitFor(`document.getElementById('cloud-account-menu').hidden && document.activeElement === document.querySelector('.cloud-account-btn')`, 'Escape closes the menu and gives the focus back to the button', 4000);
        await ev(`document.querySelector('.cloud-account-btn').click(); true`);
        await waitFor(`!document.getElementById('cloud-account-menu').hidden && document.activeElement === document.querySelector('#cloud-account-menu [role=menuitem]')`, 'a click opens it on the first item too', 4000);
        // 3. no nav: today's links; a failed read: today's links; an older Hub with analytics_tab: Usage after Saved for later
        await load({ status: 200, body: { artifacts_frame: false } });
        assert.deepEqual(await entries(), [['Servers', null], ['Account', '/account'], ['Saved for later', '/saved'], ['Sign out', null]], 'no nav: Account and Saved for later');
        await load({ status: 500, body: { error: 'x' } });
        assert.deepEqual(await entries(), [['Servers', null], ['Account', '/account'], ['Saved for later', '/saved'], ['Sign out', null]], 'a failed read changes nothing');
        await load({ status: 200, body: '"not an object"' });
        assert.deepEqual(await entries(), [['Servers', null], ['Account', '/account'], ['Saved for later', '/saved'], ['Sign out', null]], 'an answer that is not an object changes nothing');
        await load({ status: 200, body: { analytics_tab: true } });
        await waitFor(`[...document.querySelectorAll('#cloud-account-menu [role=menuitem]')].some(e => e.textContent.trim() === 'Usage')`, 'Usage for an older Hub with analytics_tab', 6000);
        assert.deepEqual(await entries(), [['Servers', null], ['Account', '/account'], ['Saved for later', '/saved'], ['Usage', '/usage'], ['Sign out', null]], 'an older Hub with analytics_tab and no nav: Usage after Saved for later (#11018)');
        // 4. an empty nav: nothing between Servers and Sign out
        await load({ status: 200, body: { nav: [] } });
        await waitFor(`document.querySelectorAll('#cloud-account-menu [role=menuitem]').length === 2`, 'an empty nav draws no entry', 6000);
        console.log('PASS the account menu draws the Hub\'s nav by key, reads /api/account once and has a menu keyboard');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
