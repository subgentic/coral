// Settings > Agents > Default models are dropdowns (Desktop tester's note, #10000): each provider's box was a blank text field ("Leave blank for none"). Now a dropdown of the models the composer offers, "The CLI's own default" first and
// "Other…" last; a model picked sets the value the form saves; Other shows the old text box for an id that is not in the list, and a saved id that is not in the list opens under Other with the id in the box. At 1280 and 390 px, 44 px
// high on a phone. Real isolated server (its model catalog); the shard's own setting is put back by the settings guard.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { guardSettings } = require('./helpers/settings_guard');

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const MOD = `(window.__coralStatic || '/static/')`;
    const put = body => ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }).then(r => r.status)`);
    const open = async () => {
        await ev(`import(${MOD} + 'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return true; }).then(() => import(${MOD} + 'modals.js')).then(m => m.showSettingsModal('agents')).then(() => true)`);
        await waitFor(`!!document.getElementById('settings-model-pick-claude') && document.getElementById('settings-model-pick-claude').options.length > 2`, 'the Claude model dropdown with its models', 15000);
        await new Promise(r => setTimeout(r, 300)); // sleep-ok: the rows settle
    };
    const state = p => ev(`(() => { const s = document.getElementById('settings-model-pick-${p}'), i = document.getElementById('settings-default-model-${p}'); if (!s) return null; const r = s.getBoundingClientRect(); return { shown: r.width > 0 && r.height > 0, h: Math.round(r.height), first: s.options[0].textContent, last: s.options[s.options.length - 1].textContent, n: s.options.length, value: s.value, input: i.value, inputShown: i.getClientRects().length > 0 }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            check(await put({ default_model_claude: '' }) === 200, 'nothing saved to start with');
            await open();
            let s = await state('claude');
            check(s && s.shown && s.first === "The CLI's own default" && s.last === 'Other…' && s.n >= 3 && s.value === '' && !s.inputShown, `a dropdown, own default chosen, the box hidden: ${JSON.stringify(s)}`);
            if (mobile) check(s && s.h >= 44, `44 px high on a phone: ${s && s.h}`);
            await ev(`document.getElementById('settings-model-pick-claude').scrollIntoView({ block: 'center' }); true`); await shot(`settings-default-models-${w}`);
            // a model from the list sets the value the form saves
            const model = await ev(`document.getElementById('settings-model-pick-claude').options[1].value`);
            await ev(`(() => { const e = document.getElementById('settings-model-pick-claude'); e.value = ${JSON.stringify(model)}; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            s = await state('claude');
            check(s.input === model && !s.inputShown, `a model sets the box's value and the box stays hidden: ${JSON.stringify(s)}`);
            check(await ev(`!document.getElementById('settings-unsaved').hidden`), 'the Unsaved changes note follows the pick');
            // Other shows the box
            await ev(`(() => { const e = document.getElementById('settings-model-pick-claude'); e.value = '__other__'; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            s = await state('claude');
            check(s.inputShown && await ev(`document.activeElement && document.activeElement.id === 'settings-default-model-claude'`), `Other shows the text box with the keyboard in it: ${JSON.stringify(s)}`);
            await shot(`settings-default-models-other-${w}`);
            // a saved id that is not in the list opens under Other
            check(await put({ default_model_claude: 'my-own-model-id' }) === 200, 'saved a custom id');
            await ev(`window.hideSettingsModal(); true`); await open();
            s = await state('claude');
            check(s.value === '__other__' && s.input === 'my-own-model-id' && s.inputShown, `a saved id that is not in the list opens under Other with the id in the box: ${JSON.stringify(s)}`);
            // a saved model from the list opens on it
            check(await put({ default_model_claude: model }) === 200, 'saved a listed model');
            await ev(`window.hideSettingsModal(); true`); await open();
            s = await state('claude');
            check(s.value === model && !s.inputShown, `a saved listed model opens on it: ${JSON.stringify(s)}`);
            for (const p of ['codex', 'agy', 'pi']) { const t = await state(p); check(t && t.shown && t.first === "The CLI's own default" && t.last === 'Other…', `${p} has its dropdown: ${JSON.stringify(t)}`); }
            await put({ default_model_claude: '' });
        }
    } finally { await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message))); await client.close(); }
    assert.deepEqual(problems, [], 'the default model dropdowns:\n  ' + problems.join('\n  '));
    console.log('PASS the default models are dropdowns');
})().catch(e => { console.error(e); process.exit(1); });
