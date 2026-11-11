// A Hub's phone hamburger opens when the hamburger lists no tab (#15479, coral-hub's live repro at c13f7c41): in a Hub at 390 px with only Inbox, Agents, Computers and Docs shown, openMenu took Docs and Computers out (#14785)
// and the bottom bar's Inbox and Agents, then returned before drawing because no tab was left: the tap did nothing, aria-expanded stayed false, and Settings, Account, GitHub and Sign out were unreachable.
// Served as the Hub serves it (mode cloud, /auth/session, /api/servers and the live list stubbed, as in hub_account_nav_browser). Chats, Automations, Skills, Analytics, Artifacts and Board are display:none, as in the live case.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Network, Fetch, Emulation } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const { waitFor } = require('./helpers/wait').bind(ev);
    try {
        await Promise.all([Page.enable(), Runtime.enable(), Network.enable()]);
        await Network.setCacheDisabled({ cacheDisabled: true });
        await Fetch.enable({ patterns: [{ urlPattern: `${BASE}/`, resourceType: 'Document', requestStage: 'Response' }, { urlPattern: `${BASE}/auth/session`, requestStage: 'Request' }, { urlPattern: `${BASE}/api/account*`, requestStage: 'Request' },
            { urlPattern: `${BASE}/api/servers*`, requestStage: 'Request' }, { urlPattern: `${BASE}/api/sessions/live*`, requestStage: 'Request' }] });
        const json = (id, status, body) => Fetch.fulfillRequest({ requestId: id, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
        safePaused(client, async e => {
            const u = e.request.url;
            if (u.endsWith('/auth/session')) return json(e.requestId, 200, { authenticated: true, email: 'tester@example.com', csrf: 'x' });
            if (/\/api\/account(\?|$)/.test(u)) return json(e.requestId, 200, {});
            if (/\/api\/servers(\?|$)/.test(u)) return json(e.requestId, 200, { servers: [{ id: 'm1', label: 'Laptop', status: 'online' }] });
            if (/\/api\/sessions\/live(\?|$)/.test(u)) return json(e.requestId, 200, { sessions: [], servers: [] });
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace('"mode":"local"', '"mode":"cloud"');
            await Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name)), body: Buffer.from(html).toString('base64') });
        });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`document.body.classList.contains('cloud-mode') && !!document.querySelector('button.phone-menu-btn[data-hamburger], #top-menu-btn')`, 'the Hub page', { timeout: 20000 });
        const KEEP = ['hub-inbox', 'agents', 'servers', 'docs'];
        await ev(`(() => { for (const t of document.querySelectorAll('.top-nav-tabs > .top-nav-tab[data-arg]')) { if (!${JSON.stringify(KEEP)}.includes(t.dataset.arg)) t.style.display = 'none'; } return true; })()`);
        const shape = await ev(`(() => ({ phoneNav: document.body.classList.contains('phone-nav-on'), shown: [...document.querySelectorAll('.top-nav-tabs > .top-nav-tab[data-arg]')].filter(t => !t.hidden && t.style.display !== 'none').map(t => t.dataset.arg).join(',') }))()`);
        await ev(`(document.querySelector('button.phone-menu-btn[data-hamburger]') || document.getElementById('top-menu-btn')).click(); true`);
        await new Promise(r => setTimeout(r, 700)); // sleep-ok: the drawer's code loads on the first tap, then the same tap's menu opens; the state below is read once settled
        const got = await ev(`(() => { const m = document.getElementById('nav-more-menu'), b = document.querySelector('button.phone-menu-btn[data-hamburger]') || document.getElementById('top-menu-btn'); return { open: !m.hidden, expanded: b.getAttribute('aria-expanded'), items: [...m.querySelectorAll('.nav-more-item')].map(x => x.textContent.trim().replace(/\\s+/g, ' ')) }; })()`);
        const problems = [];
        if (!got.open || got.expanded !== 'true') problems.push(`the hamburger did nothing: open ${got.open}, aria-expanded ${got.expanded} (${JSON.stringify(shape)})`);
        else for (const want of ['Settings', 'GitHub', 'Sign out']) if (!got.items.some(x => x.endsWith(want))) problems.push(`the menu has no ${want}: ${JSON.stringify(got.items)}`);
        if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
        console.log('hub_hamburger_empty_tabs_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
