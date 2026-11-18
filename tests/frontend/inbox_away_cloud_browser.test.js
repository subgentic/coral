// #19645 (coral-hub on #19628): "While you were away" asked /api/away of its own origin, which through the Hub is the Hub, not the computer: the line never came. On the Hub's page (the local server's own with
// the Hub's boot flag and a Hub sign-in answered, as team_presets_hub_browser does it) the question goes through serverFetch to each computer the person owns that is online (as the rest of Needs you does),
// never to the page's own origin, nor to a computer they do not own or one that is offline, and the counts are added. Isolated dev server; drives Chrome over CDP.
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;
    const S = `(window.__coralStatic || '/static/')`;
    const A = '0b1e2c3d-0000-4000-8000-00000000000a', B = '0b1e2c3d-0000-4000-8000-00000000000b', C = '0b1e2c3d-0000-4000-8000-00000000000c', D = '0b1e2c3d-0000-4000-8000-00000000000d';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Network.enable(); await Network.setBypassServiceWorker({ bypass: true });
        await Fetch.enable({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }, { urlPattern: '*/auth/session', requestStage: 'Request' }] });
        safePaused(client, async e => {
            if (e.request.url.endsWith('/auth/session')) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ authenticated: true, email: 'qa@example.com', csrf: 'qa-csrf' })).toString('base64') });
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace(/"mode":\s*"local"/, '"mode":"cloud"');
            return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name)), body: Buffer.from(html).toString('base64') });
        });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); // the Hub page does not signal __coralReady (team_presets_hub_browser does not wait for it)
        assert.equal(await ev(`JSON.parse(document.getElementById('coral-boot').textContent).mode`), 'cloud', 'the page believes it is on the Hub');
        await waitFor(`typeof window.__coralStatic !== 'undefined' || !!document.body`, 'the page', 10000);
        const got = await ev(`(async () => {
            window.__asked = []; const R = window.fetch.bind(window);
            window.fetch = (u, o) => { const s = String(u && u.url || u); if (/\\/api\\/away/.test(s)) { window.__asked.push(s); const n = /000a/.test(s) ? 2 : /000b/.test(s) ? 3 : 0; return Promise.resolve(new Response(JSON.stringify({ tasks_done: n, goals_done: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })); } return R(u, o); };
            const st = await import(${S} + 'state.js');
            st.state.servers = [{ id: 'local', status: 'online' }, { id: '${A}', owner: true, status: 'online', effective_mode: 'view' }, { id: '${B}', owner: true, status: 'online', effective_mode: 'view' }, { id: '${C}', owner: false, status: 'online' }, { id: '${D}', owner: true, status: 'offline' }];
            st.state.liveSessions = []; st.state.settings = Object.assign({}, st.state.settings, { inbox_away: 'true' });
            const RN = Date.now; let off = 0; Date.now = () => RN.call(Date) + off;
            const slot = document.createElement('div'); document.body.append(slot);
            const m = await import(${S} + 'inbox_away.js'); m.mountAway(slot, false);
            document.dispatchEvent(new Event('pointerdown')); off += 12 * 60000; document.dispatchEvent(new Event('pointerdown'));
            for (let i = 0; i < 60 && !slot.querySelector('.inbox-away'); i++) await new Promise(r => setTimeout(r, 100)); // sleep-ok: the line arrives after its own asks
            return { asked: window.__asked, text: slot.querySelector('.inbox-away-text')?.textContent || '' };
        })()`);
        const owned = got.asked.map(u => u.replace(/\?.*/, '')).sort();
        assert.deepEqual(owned, [`/api/remote/${A}/api/away`, `/api/remote/${B}/api/away`], 'asked each owned, online computer through its server, nothing else: ' + JSON.stringify(got.asked));
        assert.match(got.text, /^While you were away \(12 min\): 5 tasks done, 2 goals done\.$/, 'the counts of both computers are added: ' + got.text);
        console.log('PASS the Hub asks each owned online computer for the away line and adds the counts');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
