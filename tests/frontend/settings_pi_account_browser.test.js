// Settings > Security has one Accounts row for Claude and Pi (#11293 row 13, Pi Tester's v2.0.7 pass; one row since #11320): its Check asks Pi (GET /api/system/cli-check?type=pi&signin=1) and says signed in, not signed in,
// or that it could not tell, naming the provider the answer is for (Pi signs in per provider). The route is stood in. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await require('./helpers/wait').bind(ev).coralReady('startup', 'settings');
        await ev(`(() => { const R = window.fetch; window.__asks = []; window.__answer = {};
            window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.href);
                if (url.pathname === '/api/system/cli-check' && url.searchParams.get('signin') === '1') { window.__asks.push(url.search); return Promise.resolve(new Response(JSON.stringify(window.__answer), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);
        await ev(`(async () => { await window.showSettingsModal('security'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none' && !!document.getElementById('settings-accounts-check')`, 'the Accounts row');
        const labels = await ev(`[...document.querySelectorAll('#settings-modal .sv-label, #settings-modal label, #settings-modal .sv-row-label')].map(e => e.textContent.trim())`);
        assert.ok(labels.includes('Accounts') && !labels.includes('Pi account') && !labels.includes('Claude account'), 'one Accounts row, a line for Claude and a line for Pi: ' + JSON.stringify(labels));
        assert.deepEqual(await ev(`[...document.querySelectorAll('#settings-accounts .account-name')].map(e => e.textContent)`), ['Claude', 'Pi'], 'a line per provider');
        assert.equal(await ev(`document.getElementById('settings-accounts-check').getAttribute('aria-label')`), 'Check Claude and Pi sign-in');
        const check = async answer => { await ev(`window.__answer = ${JSON.stringify(answer)}; document.getElementById('settings-accounts-check').click(); true`); await waitFor(`document.getElementById('settings-pi-account-status').textContent !== 'Checking...' && document.getElementById('settings-pi-account-status').textContent !== ''`, 'the answer'); return ev(`document.getElementById('settings-pi-account-status').textContent`); };
        assert.equal(await check({ found: true, signed_in: true, provider: 'openai' }), 'Signed in to openai');
        assert.equal(await check({ found: true, signed_in: false, provider: 'anthropic' }), 'Not signed in to anthropic: start pi and run /login');
        assert.equal(await check({ found: true, signed_in: true }), 'Signed in', 'no provider named: nothing invented');
        assert.match(await check({ found: true, signin_timeout: true }), /^Could not tell if Pi is signed in/);
        assert.equal(await ev(`window.__asks.length`), 8, 'each Check asks Claude and Pi (4 Checks)');
        assert.ok((await ev(`window.__asks`)).every(q => /type=(pi|claude)/.test(q) && /source=settings_check/.test(q)) && (await ev(`window.__asks`)).filter(q => /type=pi/.test(q)).length === 4, 'asked for Pi once each time, with the Settings analytics source');
        console.log('PASS the Pi account row');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
