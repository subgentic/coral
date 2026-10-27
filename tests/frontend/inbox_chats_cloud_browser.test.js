// A phone's chat rows on the Hub are read-only (#9545, QA Reviewer 2's round 1): the history flags write is Never on the Hub, so in cloud mode the avatar is not a select button, no selection bar is
// ever drawn and no Star or Archive exists. The same list on a local dashboard has them (the control, in the same run). The chat folder's table is drawn by the real module over stubbed history.
// 390 px with touch; the cloud page is the local server's own with the Hub's boot flag and a Hub sign-in answered (as team_presets_hub_browser does it).
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');

const SESSIONS = [1, 2, 3].map(i => ({ session_id: 'chat-00' + i, display_name: 'Agent ' + i, agent_type: 'claude', title: 'Chat number ' + i, summary: 'First words ' + i, last_timestamp: new Date(Date.now() - i * 3600000).toISOString(), starred: false, archived: false, active: false }));

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;
    // the folder's table, drawn by the module, into the page
    const DRAW = `(async () => {
        const real = window.fetch;
        window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.origin); window.__flagWrites = window.__flagWrites || [];
            if (/\\/api\\/sessions\\/history$/.test(url.pathname)) return Promise.resolve(new Response(JSON.stringify({ sessions: ${JSON.stringify(SESSIONS)}, total: 3 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            if (/\\/api\\/sessions\\/history\\/counts$/.test(url.pathname)) return Promise.resolve(new Response(JSON.stringify({ all: 3, group: 0, notes: 0, starred: 0, active: 0, archived: 0, by_agent_type: {}, tags: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            if (/\\/flags$/.test(url.pathname)) window.__flagWrites.push(url.pathname);
            return real(u, o); };
        const CH = await import((window.__coralStatic || '/static/') + 'mailbox_chats.js');
        const ctx = { query: '', params: {}, redraw: () => { window.__redraws = (window.__redraws || 0) + 1; }, open: () => {}, after: () => {}, selection: bar => { if (bar) window.__selectionDrawn = true; } };
        let spec = CH.chatsSpec('chats', ctx);
        for (let i = 0; i < 50 && !spec.rows.length; i++) { await new Promise(r => setTimeout(r, 100)); spec = CH.chatsSpec('chats', ctx); } // timeout-ok: the stubbed history answers within a few turns
        document.getElementById('zz-host')?.remove();
        const host = document.createElement('div'); host.id = 'zz-host'; host.style.cssText = 'position:fixed;inset:0;z-index:50;background:var(--bg-primary);overflow:auto'; document.body.append(host);
        host.append(spec.node());
        return spec.rows.length; })()`;
    const probe = () => ev(`(() => ({ rows: document.querySelectorAll('#zz-host tr.dt-mailed').length, leads: document.querySelectorAll('#zz-host button.dt-mail-lead').length, flags: document.querySelectorAll('#zz-host .dt-chat-flags').length, bar: !!window.__selectionDrawn || !!document.querySelector('.dt-bar-action'), boot: JSON.parse(document.getElementById('coral-boot').textContent).mode }))()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        // the control: a local dashboard has the select buttons
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        assert.equal(await ev(DRAW), 3, 'three chats');
        let p = await probe();
        assert.deepEqual([p.boot, p.rows, p.leads], ['local', 3, 3], 'local: three mail rows, each avatar a select button ' + JSON.stringify(p));
        // the window crosses 767 px: the owner is asked to draw the table again (the select buttons exist on a phone only)
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await waitFor(`(window.__redraws || 0) >= 1`, 'a redraw when the window crosses the phone width', 4000);
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
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
        // the Hub's Inbox reads the online computers (a dashboard on the Hub has no computer of its own: inboxSources, #9542): one is online
        await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); state.hub = true; state.servers = [{ id: 'm1', status: 'online', label: 'Mac' }]; return true; })()`);
        assert.equal(await ev(DRAW), 3, 'three chats on the Hub');
        p = await probe();
        assert.equal(p.boot, 'cloud', 'the page believes it is on the Hub');
        assert.equal(p.rows, 3, 'the rows are mail rows on the Hub too ' + JSON.stringify(p));
        assert.equal(p.leads, 0, 'but no avatar is a select button ' + JSON.stringify(p));
        assert.ok(!p.bar && p.flags === 0, 'no selection bar, no Star or Archive ' + JSON.stringify(p));
        await ev(`document.querySelector('#zz-host tr.dt-mailed .dt-mail-lead').click(); true`); // a tap on the avatar is nothing
        assert.deepEqual(await ev(`[!!document.querySelector('.dt-bar-action'), window.__flagWrites || []]`), [false, []], 'a tap on the avatar draws no bar and writes no flag');
        console.log('PASS the Hub\'s phone chat rows are read-only');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
