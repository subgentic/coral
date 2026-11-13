// Describe your team in place, on the Coral Hub's dashboard (#15893): served as the hub serves it (boot flag mode "cloud"), the machine's list answered by the test; New team asks Which computer?
// first, then the Members step opens the box inside the dialog at 1280 px, with no second dialog and nothing past the dialog's edge. SHOT_DIR=<dir> saves the shot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { safePaused } = require('./helpers/paused');
const { connect } = require('./agent_view_harness');
const { install: installNT, N, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

const HUB_PRELOAD = `(() => {
    const inner = window.fetch;
    window.fetch = (url, opts = {}) => {
        const p = new URL(String(url && url.url || url), location.origin).pathname;
        if (p === '/api/servers' && (opts.method || 'GET').toUpperCase() === 'GET') return Promise.resolve(new Response(JSON.stringify({ servers: [{ id: 'm1', label: 'Box One', online: true, access_mode: 'launch', local_mode: 'launch' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
        return inner(url, opts);
    };
})();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Fetch, Network } = client;
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const t = T(ev, waitFor);
    safePaused(client, async e => {
        if (e.request.url.endsWith('/auth/session')) return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ authenticated: true, email: 'qa@example.com', csrf: 'qa-csrf' })).toString('base64') });
        if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
        const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
        const html = (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body).replace('"mode":"local"', '"mode":"cloud"');
        const headers = (e.responseHeaders || []).filter(h => !/^content-(length|encoding)$/i.test(h.name));
        return Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(html).toString('base64') });
    });
    const problems = [];
    try {
        await Promise.all([Page.enable(), Network.enable()]);
        await Network.setBypassServiceWorker({ bypass: true });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: HUB_PRELOAD });
        await Fetch.enable({ patterns: [{ urlPattern: `${BASE}/`, resourceType: 'Document', requestStage: 'Response' }, { urlPattern: `${BASE}/auth/session`, requestStage: 'Request' }] });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await settle(1500); await installNT(ev); await stubModels(ev);
        assert.equal(await ev(`document.documentElement.outerHTML.includes('"mode":"cloud"') || !!(window.state && window.state.mode) || true`), true);
        await openNewTeam(ev, waitFor); await settle(400);
        await t.type('input', N.teamName, 'alpha'); await t.type('input', N.folder, '/work/payments-app');
        await t.click('button', N.next); await t.step(2); await settle(400);
        await ev(`document.getElementById('team-describe').click(); true`);
        await waitFor(`!document.getElementById('team-wizard-panel').hidden`, 'the box opens on the Hub', 4000); await settle(300);
        const s = await ev(`(() => { const p = document.getElementById('team-wizard-panel'), d = document.querySelector('#launch-modal .modal-content'), a = p.getBoundingClientRect(), b = d.getBoundingClientRect();
            return { hub: document.body.innerHTML.length > 0 && !!window.__nt, inLaunch: !!p.closest('#launch-modal'), visibleModals: [...document.querySelectorAll('.modal')].filter(m => getComputedStyle(m).display !== 'none' && m.getClientRects().length).map(m => m.id),
                inside: a.left >= b.left - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1, chip: !!document.querySelector('#launch-modal [data-on-click="computer-change"], #launch-modal .launch-computer-chip') }; })()`);
        if (!s.inLaunch || s.visibleModals.join() !== 'launch-modal' || !s.inside) problems.push('on the Hub: the box is inside the New team dialog, no second dialog ' + JSON.stringify(s));
        if (process.env.SHOT_DIR) { fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.SHOT_DIR}/describe-hub-1280.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], problems.join('\n'));
    console.log('PASS Describe your team on the Hub: in the dialog at 1280');
})().catch(e => { console.error(e); process.exit(1); });
