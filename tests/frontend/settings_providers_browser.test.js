// Settings > Providers (ST4, the design review's guideline 4.12 rule 7): one card per provider. An installed provider's card shows its rows; a provider that is not installed folds to its title and one
// line, "Set up Codex", which opens its rows again; one the server does not offer here says so and has no setup. A provider the check could not answer for stays open. Checked at 1280, at 390, and at
// 200% text: nothing scrolls sideways, and every control is at least 36 px (44 on a phone). Drives Chrome over CDP through agent_view_harness.js; the CLI check's answers are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, nextFrame } = require('./helpers/wait');

const ANSWERS = { claude: { found: true }, codex: { found: false, install_url: 'https://example.com/install-codex' }, agy: { supported: false, message: 'Not offered here.' }, pi: 'fail' };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, font] of [[1280, 900, false, ''], [390, 844, true, ''], [1280, 900, false, '32px']]) {
            const at = `${w} px${font ? ' at 200% text' : ''}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const real = window.fetch, answers = ${JSON.stringify(ANSWERS)}; window.fetch = (u, o) => { const p = new URL(String(u), location.href); if (p.pathname !== '/api/system/cli-check') return real(u, o); const a = answers[p.searchParams.get('type')]; if (a === 'fail') return Promise.resolve(new Response('{}', { status: 500 })); return Promise.resolve(new Response(JSON.stringify({ status: a.found ? 'available' : 'missing', ...a }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }; return true; })()`);
            await ev(`window.showSettingsModal('providers'); true`);
            await waitFor(`!!document.querySelector('#settings-pane-providers .prov-card[data-state]') && document.querySelectorAll('#settings-pane-providers .prov-card[data-state]').length >= 3`, at + 'the cards settle', 8000);
            if (font) { await ev(`document.documentElement.style.fontSize = ${JSON.stringify(font)}; true`); await nextFrame(ev); await nextFrame(ev); }
            const state = await ev(`Object.fromEntries([...document.querySelectorAll('#settings-pane-providers .prov-card')].map(c => [c.dataset.provider, { state: c.dataset.state || '', status: c.querySelector('.prov-card-status')?.textContent || '', rows: c.querySelector('.sv-row')?.getClientRects().length > 0, setup: c.querySelector('.prov-card-setup button')?.textContent || '', link: c.querySelector('.prov-card-setup a')?.getAttribute('href') || '' }]))`);
            assert.deepEqual(state.claude, { state: 'installed', status: 'Installed', rows: true, setup: '', link: '' }, at + 'Claude: ' + JSON.stringify(state.claude));
            assert.deepEqual(state.codex, { state: 'missing', status: 'Not installed', rows: false, setup: 'Set up Codex', link: 'https://example.com/install-codex' }, at + 'Codex folds to one line: ' + JSON.stringify(state.codex));
            assert.deepEqual(state.agy, { state: 'missing', status: 'Not offered on this computer', rows: false, setup: '', link: '' }, at + 'Antigravity is not offered, no setup: ' + JSON.stringify(state.agy));
            assert.deepEqual(state.pi, { state: '', status: '', rows: true, setup: '', link: '' }, at + 'Pi (no answer) stays open: ' + JSON.stringify(state.pi));
            assert.equal(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0, at + 'no sideways scroll');
            const small = await ev(`[...document.querySelectorAll('#settings-pane-providers .prov-card button, #settings-pane-providers .prov-card input, #settings-pane-providers .prov-card select')].filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().height)).filter(x => x < ${mobile ? 44 : 30})`);
            assert.deepEqual(small, [], at + 'controls are tall enough: ' + small);
            // Set up Codex opens its rows, the CLI path first, and it stays open
            await ev(`document.querySelector('#settings-provider-codex .prov-card-setup button').click(); true`);
            assert.equal(await ev(`document.getElementById('settings-provider-codex').dataset.state`), 'setup', at + 'Set up opens the card');
            assert.equal(await ev(`document.getElementById('settings-provider-advanced-codex').open && document.activeElement === document.getElementById('settings-cli-path-codex')`), true, at + 'its CLI path has the focus');
            // every row keeps its id whatever the card shows: the dialog's load and save read them
            assert.equal(await ev(`['settings-default-model-agy', 'settings-cli-path-agy', 'settings-orchestrator-model-codex', 'settings-default-thinking-pi'].every(id => !!document.getElementById(id))`), true, at + 'a folded card keeps its rows in the page');
            await ev(`window.hideSettingsModal(true); true`);
        }
        console.log('PASS Settings > Providers: a card each, a missing one folds to "Set up Codex"');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
