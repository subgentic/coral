// #21543: a remote browser (through a proxy or Coral Hub) is not at the computer, and the routes only that person may read answer it 403 other_user: /api/cloud/status, /api/cloud/link-requests
// and /api/system/terminal-backend. The dashboard asks the auth status first (`local`) and does not ask them when it says false: no wasted round trip, no console noise.
// Two loads on an isolated dev server: the auth status read says local:false (remote), then the real answer (at the computer, the control: the same routes are asked).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const ROUTES = ['/api/cloud/status', '/api/cloud/link-requests', '/api/system/terminal-backend'];
const FAKE = `(() => { const R = window.fetch; window.__asked = []; window.fetch = (u, o) => { const p = new URL(String(u && u.url || u), location.href).pathname; window.__asked.push(p);
    if (p === '/api/system/auth-status' && localStorage.getItem('__remote') === '1') return R(u, o).then(r => r.json()).then(d => new Response(JSON.stringify({ ...d, local: false }), { headers: { 'content-type': 'application/json' } }));
    return R(u, o); }; })();`;
(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: FAKE });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        const load = async remote => {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await ev(`localStorage.${remote ? "setItem('__remote', '1')" : "removeItem('__remote')"}; true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await new Promise(r => setTimeout(r, 2500)); // sleep-ok: the startup readers and the first poll have all asked by then
            return ev(`window.__asked.filter(p => ${JSON.stringify(ROUTES)}.includes(p))`);
        };
        const control = await load(false);
        assert.ok(control.includes('/api/cloud/status') && control.includes('/api/system/terminal-backend'), 'at the computer the page asks the owner routes: ' + JSON.stringify(control));
        const remote = await load(true);
        assert.deepEqual(remote, [], 'a remote browser asks none of the owner-only routes: ' + JSON.stringify(remote));
        console.log('PASS remote browser skips the owner-only routes (' + JSON.stringify(control) + ' at the computer)');
    } finally { await ev(`localStorage.removeItem('__remote'); true`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
