// Settings > Security: "API key" is Coral's own key (#10526, Desktop Settings pass: it read as a Claude or OpenAI key), and a "Claude account" row says agents sign in through the Claude CLI's own login,
// with a Check that asks the CLI (GET /api/system/cli-check?type=claude&signin=1) and says signed in, not signed in, or that it could not tell. When not signed in, a Sign in button starts claude auth login
// on this computer (POST /api/system/cli-signin?type=claude, #16714); through the Hub the button is hidden and the text says to sign in on the computer. The routes are stood in. Drives Chrome over CDP.
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
        await ev(`(() => { const R = window.fetch; window.__asks = []; window.__signins = []; window.__answer = { found: true, signed_in: true }; window.__signinAnswer = { started: true };
            window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.href);
                if (url.pathname === '/api/system/cli-check' && url.searchParams.get('signin') === '1') { window.__asks.push(url.search); return Promise.resolve(new Response(JSON.stringify(window.__answer), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                if (url.pathname === '/api/system/cli-signin' && o && o.method === 'POST') { window.__signins.push(url.search); return Promise.resolve(new Response(JSON.stringify(window.__signinAnswer), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);
        await ev(`(async () => { await window.showSettingsModal('security'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none' && !!document.getElementById('settings-accounts-check')`, 'the Accounts row');
        const labels = await ev(`[...document.querySelectorAll('#settings-modal .sv-label, #settings-modal label, #settings-modal .sv-row-label')].map(e => e.textContent.trim())`);
        assert.ok(labels.some(t => t === 'Coral API key'), 'the key is labelled Coral API key: ' + JSON.stringify(labels));
        assert.ok(labels.some(t => t === 'Accounts'), 'an Accounts row, one for Claude and Pi (#11320): ' + JSON.stringify(labels));
        assert.equal(await ev(`document.getElementById('settings-api-key').getAttribute('aria-label')`), 'Coral API key');
        assert.equal(await ev(`document.getElementById('settings-accounts-check').getAttribute('aria-label')`), 'Check provider sign-in');
        const more = await ev(`(() => { const a = document.getElementById('settings-accounts').closest('.sv-row').querySelector('a.sv-learn'); return a && {href:a.getAttribute('href'),label:a.getAttribute('aria-label')}; })()`);
        assert.deepEqual(more, {href:'/docs/settings-system',label:'Learn more about Accounts, in Docs'});
        assert.match(await ev(`fetch('/api/agent-docs/settings-system').then(r=>r.json()).then(d=>d.content)`), /each CLI's own login/, 'the complete account explanation is retained in Docs');
        const signInBtn = () => ev(`(() => { const b = document.querySelector('#settings-accounts button[aria-label="Sign in to Claude"]'); return b ? { hidden: b.hidden, disabled: b.disabled, text: b.textContent } : null; })()`);
        const check = async answer => { await ev(`window.__answer = ${JSON.stringify(answer)}; document.getElementById('settings-accounts-check').click(); true`); await waitFor(`document.getElementById('settings-claude-account-status').textContent !== 'Checking...' && document.getElementById('settings-claude-account-status').textContent !== 'Not checked yet'`, 'the answer'); return ev(`document.getElementById('settings-claude-account-status').textContent`); };
        assert.equal(await check({ found: true, signed_in: true }), 'Signed in');
        assert.deepEqual(await signInBtn(), { hidden: true, disabled: false, text: 'Sign in' }, 'Sign in button hidden when signed in');
        assert.equal(await check({ found: true, signed_in: false }), 'Not signed in');
        assert.deepEqual(await signInBtn(), { hidden: false, disabled: false, text: 'Sign in' }, 'Sign in button visible when not signed in');
        await ev(`document.querySelector('#settings-accounts button[aria-label="Sign in to Claude"]').click(); true`);
        await waitFor(`window.__signins.length >= 1`, 'the sign-in POST');
        assert.ok((await ev(`window.__signins`))[0].includes('type=claude'), 'POST /api/system/cli-signin?type=claude called');
        assert.match(await ev(`document.getElementById('settings-claude-account-status').textContent`), /Sign-in started/, 'status says sign-in started');
        assert.match(await check({ found: true, signal: 1 }), /^Could not tell/);
        assert.equal(await ev(`window.__asks.length`), 9, 'each Check asks all three CLIs, three Checks');
        assert.ok((await ev(`window.__asks`)).every(q => /source=settings_check/.test(q)), 'the Settings Check has its own analytics source');
        console.log('PASS Coral API key, the Claude account row and the Sign in button');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
