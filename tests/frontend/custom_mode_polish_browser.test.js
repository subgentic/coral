// Custom permission mode polish (#16389, beta walk #16381): (1) New agent's flags line for a custom mode says the mode's real flags ("Adds --permission-mode acceptEdits to the command."), not the internal
// id ("--permission-mode custom:abcd…"): the preview resolves the mode as a launch does; (2) adding a mode with a flag the CLI does not accept says the refusal once, not twice. Against the real server. 1280 px.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;
const { install: installNA, stubModels, stubCliChecks } = require('./helpers/new_agent');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await guardSettings();
    const S = `(window.__coralStatic || '/static/')`;
    const put = modes => ev(`fetch('/api/custom-modes', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modes: ${JSON.stringify(modes)} }) }).then(r => r.status)`);
    const load = async () => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await load(); await put([]);

        // (2) a flag the CLI does not accept: the refusal sentence is on the screen once
        await load();
        await ev(`window.showSettingsModal('agents'); true`);
        await waitFor(`!!document.querySelector('#settings-custom-modes [data-cpm-add]')`, 'the custom modes block', 8000);
        await ev(`document.querySelector('#settings-custom-modes [data-cpm-add]').click(); true`);
        await waitFor(`!!document.getElementById('cpm-name')`, 'the add form');
        await ev(`(() => { document.getElementById('cpm-name').value = 'Bogus'; document.getElementById('cpm-flags').value = '--bogus-flag'; document.querySelector('#settings-custom-modes .cm-form .sv-save').click(); return true; })()`);
        await waitFor(`/bogus-flag/.test(document.getElementById('settings-custom-modes').textContent) && /not|accept|allow|flag/i.test(document.getElementById('settings-custom-modes').textContent)`, 'the refusal', 6000);
        const said = await ev(`(() => { const host = document.getElementById('settings-custom-modes'); const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; const out = []; const walk = n => { if (n.nodeType === 3) { if (/bogus-flag/.test(n.textContent) && n.parentElement && vis(n.parentElement)) out.push(n.textContent.trim()); } else if (n.nodeType === 1) for (const c of n.childNodes) walk(c); }; walk(host); return out; })()`);
        assert.equal(said.length, 1, 'the refusal for --bogus-flag is said once, got ' + JSON.stringify(said));
        assert.deepEqual(await ev(`fetch('/api/custom-modes').then(r => r.json()).then(d => d.modes.length)`), 0, 'nothing was saved');
        await ev(`window.hideSettingsModal && window.hideSettingsModal(); true`);

        // (1) the flags line for a custom mode is the mode's own flags
        assert.equal(await put([{ name: 'Edits ok', agent_type: 'claude', flags: ['--permission-mode', 'acceptEdits'] }]), 200);
        await load(); await installNA(ev); await stubModels(ev); await stubCliChecks(ev, []);
        await ev(`import(${S} + 'custom_modes.js').then(m => m.warmCustomModes(true)).then(() => true)`);
        const mode = await ev(`import(${S} + 'state.js').then(m => 'custom:' + m.state.customModes.find(x => x.name === 'Edits ok').id)`);
        await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
        await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000);
        await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) { i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
        await ev(`window._launchStage('persona'); true`);
        await waitFor(`document.getElementById('launch-agent-pick') && document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards', 10000);
        await ev(`(() => { const t = document.querySelector('#launch-agent-acf .acf-agent-type'); t.value = 'claude'; t.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`[...document.querySelector('#launch-agent-acf .acf-permission-mode').options].some(o => o.value === ${JSON.stringify(mode)})`, 'the custom option');
        await ev(`(() => { const m = document.querySelector('#launch-agent-acf .acf-permission-mode'); m.value = ${JSON.stringify(mode)}; m.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`/^Adds .* to the command\\.$/.test(document.querySelector('#launch-recap .launch-recap-flags')?.textContent || '')`, 'the flags line', 6000);
        assert.equal(await ev(`document.querySelector('#launch-recap .launch-recap-flags').textContent`), 'Adds --permission-mode acceptEdits to the command.', 'the line says the mode\'s real flags, not its id');
        console.log('PASS a custom mode shows its real flags in New agent, and a refused flag is said once');
    } finally { await put([]).catch(() => {}); await guard.restore?.().catch?.(() => {}); await client.close(); }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
