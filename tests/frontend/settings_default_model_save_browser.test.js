// Settings > Agents > Default models: a model picked in the dropdown (and a typed id under Other) is saved, shows Saved, and is still there on reopen (#16667, walk 29 F1: Haiku went back to "The CLI's own default", no Save, no toast).
// The dropdown only sets the text box the form reads, so autosave found no changed field for it. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { guardSettings } = require('./helpers/settings_guard');
const { coralReady } = require('./helpers/wait');
(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ default_model_claude: '' }) }).then(r => r.status)`);
        await ev(`window.__w = []; const R = window.fetch; window.fetch = (u, o = {}) => { if (String(u).includes('/api/settings') && o.method === 'PUT') window.__w.push(o.body); return R(u, o); }; true`);
        await ev(`import(${MOD} + 'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return true; }).then(() => window.showSettingsModal('agents')).then(() => true)`);
        await waitFor(`!!document.getElementById('settings-model-pick-claude') && document.getElementById('settings-model-pick-claude').options.length > 2`, 'dropdown', 15000);
        const open = () => ev(`Promise.resolve(window.showSettingsModal('agents')).then(() => true)`);
        const saved = () => ev(`fetch('/api/settings').then(r => r.json()).then(d => d.settings.default_model_claude)`);
        const pick = async v => ev(`(() => { const e = document.getElementById('settings-model-pick-claude'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
        const hk = await ev(`(() => { const o = [...document.getElementById('settings-model-pick-claude').options].find(o => /haiku/i.test(o.value + o.textContent)); return o ? o.value : null; })()`);
        assert.ok(hk, 'the dropdown offers Haiku');
        assert.equal(await pick(hk), hk);
        await waitFor(`!!document.querySelector('#settings-model-pick-claude').closest('.sv-row').querySelector('.settings-save-status')?.textContent.includes('Saved')`, 'the Saved note after picking Haiku', 10000);
        assert.equal(await saved(), hk, 'Haiku is stored');
        assert.ok(!(await ev(`document.getElementById('settings-model-pick-claude').closest('.sv-row').querySelector('.settings-save-status').hasAttribute('data-error')`)));
        // reopen: the dropdown still says Haiku, not the CLI's own default
        await ev(`document.querySelector('#settings-modal .modal-close, #settings-modal [data-close]')?.click(); true`);
        await open();
        await waitFor(`document.getElementById('settings-model-pick-claude')?.options.length > 2`, 'dropdown after reopen', 15000);
        assert.equal(await ev(`document.getElementById('settings-model-pick-claude').value`), hk, 'reopened on Haiku');
        // a typed id (Other...) saves too, and the CLI's own default clears it
        await pick('__other__');
        await ev(`(() => { const i = document.getElementById('settings-default-model-claude'); i.focus(); i.value = 'my-typed-model'; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); return true; })()`);
        await waitFor(`true`, 'x', 1).catch(() => {});
        const t0 = Date.now(); let v; while (Date.now() - t0 < 10000 && (v = await saved()) !== 'my-typed-model') await new Promise(r => setTimeout(r, 200)); // sleep-ok: poll the store
        assert.equal(v, 'my-typed-model', 'a typed id is stored');
        assert.equal(await pick(''), '');
        const t1 = Date.now(); while (Date.now() - t1 < 10000 && (v = await saved()) !== '') await new Promise(r => setTimeout(r, 200)); // sleep-ok: poll the store
        assert.equal(v, '', 'the CLI default clears it');
        console.log('\nPASS A model picked in Default models is saved, shown on reopen, and a typed id saves');
    } finally { await guard.restore?.().catch(() => {}); await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
