// Settings > Security: "API key" is Coral's own key (#10526, Desktop Settings pass: it read as a Claude or OpenAI key), and a "Claude account" row says agents sign in through the Claude CLI's own login,
// with a Check that asks the CLI (GET /api/system/cli-check?type=claude&signin=1) and says signed in, not signed in, or that it could not tell. The route is stood in. Drives Chrome over CDP.
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
        await ev(`(() => { const R = window.fetch; window.__asks = []; window.__answer = { found: true, signed_in: true };
            window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.href);
                if (url.pathname === '/api/system/cli-check' && url.searchParams.get('signin') === '1') { window.__asks.push(url.search); return Promise.resolve(new Response(JSON.stringify(window.__answer), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);
        await ev(`(async () => { await window.showSettingsModal('security'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none' && !!document.getElementById('settings-claude-account-check')`, 'the Claude account row');
        const labels = await ev(`[...document.querySelectorAll('#settings-modal .sv-label, #settings-modal label, #settings-modal .sv-row-label')].map(e => e.textContent.trim())`);
        assert.ok(labels.some(t => t === 'Coral API key'), 'the key is labelled Coral API key: ' + JSON.stringify(labels));
        assert.ok(labels.some(t => t === 'Claude account'), 'a Claude account row: ' + JSON.stringify(labels));
        assert.equal(await ev(`document.getElementById('settings-api-key').getAttribute('aria-label')`), 'Coral API key');
        assert.match(await ev(`document.getElementById('settings-claude-account-check').title`), /Claude CLI's own login/, 'the explanation is on the Check button, not a line of the pane');
        const check = async answer => { await ev(`window.__answer = ${JSON.stringify(answer)}; document.getElementById('settings-claude-account-check').click(); true`); await waitFor(`document.getElementById('settings-claude-account-status').textContent !== 'Checking...' && document.getElementById('settings-claude-account-status').textContent !== 'Not checked yet'`, 'the answer'); return ev(`document.getElementById('settings-claude-account-status').textContent`); };
        assert.equal(await check({ found: true, signed_in: true }), 'Signed in');
        assert.match(await check({ found: true, signed_in: false }), /^Not signed in: run claude auth login/);
        assert.match(await check({ found: true, signal: 1 }), /^Could not tell/);
        assert.equal(await ev(`window.__asks.length`), 3, 'each Check asks the CLI');
        console.log('PASS Coral API key and the Claude account row');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
