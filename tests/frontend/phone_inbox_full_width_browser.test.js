// On a phone the Inbox has the whole width (#9882, coral-hub's ask with its shot): the Agents sidebar's narrow column (a stray Search box and sort icon, about 90 px) is not drawn while the Inbox is open, so the
// Inbox is not squeezed to about 300 px. The Hub-served dashboard (the page with the Hub's boot flag and a Hub sign-in answered, as cloud_automations_redirect_browser does it) and a local one, 390 px with touch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const measure = () => ev(`(() => { const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { left: Math.round(b.left), width: Math.round(b.width), shown: e.getClientRects().length > 0 }; };
        const content = ['#inbox-frame', '#group-table-view', '#mobile-inbox-list', '.sidebar-pane[data-pane="hub-inbox"]', '#inbox-page'].map(q => document.querySelector(q)).find(e => e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 0) || null; const view = content;
        const narrow = [...document.querySelectorAll('.sidebar, #sidebar, .sidebar-pane')].filter(e => e.getClientRects().length > 0 && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 200).map(e => (e.id || e.className) + ':' + Math.round(e.getBoundingClientRect().width));
        return { tab: document.body.getAttribute('data-nav-tab'), narrow, content: r(content), box: r(view), vw: innerWidth }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        const openInbox = async (label, hub = false) => {
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            if (hub) await waitFor(`!!document.getElementById('coral-boot') && JSON.parse(document.getElementById('coral-boot').textContent).mode === 'cloud'`, label + ": the Hub's boot flag", 10000); else await ev(`window.__coralReady.then(() => true)`);
            await waitFor(`!!document.body.getAttribute('data-nav-tab')`, label + ': a tab is on screen', 10000);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.body.getAttribute('data-nav-tab') === 'hub-inbox' && document.querySelectorAll('.view-list-item, #group-table-view').length > 0`, label + ': the Inbox', 12000);
                        const m = await measure(); await shot('phone-inbox-' + label);
            assert.deepEqual(m.narrow, [], label + ': no narrow Agents column beside the Inbox ' + JSON.stringify(m));
            assert.ok(m.content && m.content.left <= 8 && m.content.width >= m.vw - 16, label + ': the Inbox has the whole width ' + JSON.stringify(m));
            console.log(`PASS ${label}: the Inbox has the whole width (${m.content.width} of ${m.vw})`);
        };
        await openInbox('local');
        await Network.enable(); await Network.setBypassServiceWorker({ bypass: true });
        await Fetch.enable({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }, { urlPattern: '*/auth/session', requestStage: 'Request' }] });
        safePaused(client, async e => {
            if (e.request.url.endsWith('/auth/session')) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ authenticated: true, user: { email: 'op@example.invalid', role: 'owner' }, role: 'owner' })).toString('base64') });
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace(/"mode":\s*"local"/, '"mode":"cloud"');
            return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name)), body: Buffer.from(html).toString('base64') });
        });
        await openInbox('hub', true);
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
