// A folded table row at large text keeps its name whole (#9430, #9427 finding 4): on a phone at 200% text the Servers page's first line held the name and two nowrap buttons (Rename, More) and left the name
// about 70 px ("Unnamed server" read "Unnar"). The shared table's folded first line gives the name a room of its own (8 rem, which grows with the text): when the actions do not fit beside it they go under
// the name. 390 px, touch, the root font at 32 px, the Hub page mode with two computers, one with no name; at normal text the row is unchanged (name and actions on one line). Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const SERVERS = [
    { id: 'm1', label: '', online: true, access_mode: 'launch', local_mode: 'launch', last_seen: '2026-10-13T00:00:00Z' },
    { id: 'm2', label: 'Old Laptop with a rather long display name', online: true, access_mode: 'launch', local_mode: 'launch', last_seen: '2026-10-13T00:00:00Z' },
];
const LIVE = [{ id: 'm1', label: '', status: 'online', coral_version: '2.0.1', agents: 1 }, { id: 'm2', label: 'Old Laptop with a rather long display name', status: 'offline', coral_version: '2.0.0', agents: 0 }];
const CLOUD_PRELOAD = `(() => { const inner = window.fetch; window.fetch = (url, opts = {}) => { const p = new URL(String(url), location.origin).pathname;
    if (p === '/api/servers' && (opts.method || 'GET').toUpperCase() === 'GET') return Promise.resolve(new Response(JSON.stringify({ servers: ${JSON.stringify(SERVERS)} }), { status: 200, headers: { 'content-type': 'application/json' } }));
    return inner(url, opts); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;
    const { settle } = require('./helpers/wait').bind(ev);
    const shot = require('./helpers/scene_shots')(Page, 'folded-actions');
    try {
        await Promise.all([Page.enable(), Network.enable()]);
        await Network.setBypassServiceWorker({ bypass: true });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: CLOUD_PRELOAD });
        await Fetch.enable({ patterns: [{ urlPattern: `${BASE}/*`, resourceType: 'Document', requestStage: 'Response' }, { urlPattern: `${BASE}/auth/session`, requestStage: 'Request' }] });
        safePaused(client, async e => {
            if (e.request.url.endsWith('/auth/session')) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ authenticated: true, email: 'qa@example.com', csrf: 'qa-csrf' })).toString('base64') });
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace('"mode":"local"', '"mode":"cloud"');
            const headers = (e.responseHeaders || []).filter(h => !/^content-(length|encoding)$/i.test(h.name));
            return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(html).toString('base64') });
        });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`(() => { T.state.servers = ${JSON.stringify(LIVE)}; return true; })()`);
        await ev(`document.getElementById('nav-tab-servers').click(); true`);
        await waitFor(`document.querySelectorAll('#servers-view .cs-row').length === ${SERVERS.length}`, 'the server rows', 8000);
        const geo = () => ev(`[...document.querySelectorAll('#servers-view .cs-row')].map(r => { const name = r.querySelector('.dt-primary, .cs-name'), btns = [...r.querySelectorAll('button')].filter(b => b.getClientRects().length && /Rename|More/.test(b.textContent)); return { name: name ? { w: Math.round(name.getBoundingClientRect().width), top: Math.round(name.getBoundingClientRect().top), clipped: name.scrollWidth > name.clientWidth + 1, text: name.textContent.trim() } : null, btns: btns.map(b => ({ t: b.textContent.trim(), top: Math.round(b.getBoundingClientRect().top) })) }; })`);
        const normal = await geo();
        assert.ok(normal.every(r => r.name && !r.name.clipped && r.btns.length === 2 && Math.abs(r.btns[0].top - r.name.top) < 16), `at normal text the name and its actions are one line, as before: ${JSON.stringify(normal)}`);
        await ev(`document.documentElement.style.fontSize = '32px'; true`); await settle(800);
        const large = await geo();
        assert.ok(large.every(r => r.name && !r.name.clipped && r.name.w >= 160), `at 200% text the name is whole, not "Unnar" (at least 160 px): ${JSON.stringify(large)}`);
        assert.ok(large.every(r => r.btns.length === 2 && r.btns.every(b => b.top > r.name.top + 20)), `and the actions are on the line under it: ${JSON.stringify(large)}`);
        assert.equal(await ev(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'nothing wider than the screen');
        await shot('large');
        console.log('data_table_folded_actions: ok');
        process.exit(0);
    } catch (e) { console.error(e); process.exit(1); } finally { await client.close(); }
})();
