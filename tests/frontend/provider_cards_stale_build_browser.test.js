// #16448 (the deterministic test behind #16404's fix 87042ba47): when a dialog opens again, its provider cards are built again on the SAME group with a NEW form (the Agent Team dialog's own form, not the
// form the first build drew). The older build's 'cli-checked' listener must then draw nothing: drawing put the OLD form's Model row into the group, a second Model field the new form's own reads missed.
// Isolated dev server; every CLI check and model list is stubbed, so no timing is involved: the first build is complete, the second build owns the group, then a CLI check answers.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, stubModels, stubCliChecks } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev); await stubModels(ev); await stubCliChecks(ev, []);
        await ev(`(async () => {
            const m = await import((window.__coralStatic || '/static/') + 'launch_provider_cards.js');
            const form = id => { const f = document.createElement('div'); f.id = id; f.innerHTML = '<select class="acf-agent-type"><option value="claude">claude</option><option value="codex">codex</option></select><div class="sv-row" data-key="model"><input class="acf-model" data-owner="' + id + '"></div><div class="sv-row" data-key="thinking"><select class="acf-thinking"></select></div>'; document.body.append(f); return f; };
            const group = document.createElement('div'); group.id = 'stale-pick'; document.body.append(group);
            const a = form('form-old'), b = form('form-new');
            await m.buildProviderCards({ group, form: a, server: 'local', implicitDefault: true });   // the first dialog open: complete, listening for cli-checked
            await m.buildProviderCards({ group, form: b, server: 'local', implicitDefault: true });   // the dialog opened again: a new form, the same group; this build owns it
            window.__drawn = []; // every node of the OLD form's that is put into the group from here on
            new MutationObserver(rs => { for (const r of rs) for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches('[data-owner="form-old"]') || n.querySelector('[data-owner="form-old"]'))) window.__drawn.push(n.className || n.tagName); }).observe(group, { childList: true, subtree: true });
            return true; })()`);
        await waitFor(`document.getElementById('stale-pick').dataset.probed === '1'`, 'the second build heard from the CLI checks', 8000);
        const before = await ev(`document.getElementById('stale-pick').querySelectorAll('.acf-model').length`);
        assert.equal(before, 1, 'one Model field in the group before the check answers');
        // the CLI check answers (Check again, or Set path and Save): both builds' listeners hear it
        await ev(`document.dispatchEvent(new CustomEvent('cli-checked', { detail: { type: 'claude', found: true, refused: '' } })); true`);
        const r = await ev(`(() => { const g = document.getElementById('stale-pick'); return { drawn: window.__drawn, models: [...g.querySelectorAll('.acf-model')].map(x => x.dataset.owner) }; })()`);
        assert.deepEqual(r.drawn, [], 'the older build drew nothing of its own form into the group: ' + JSON.stringify(r));
        assert.deepEqual(r.models, ['form-new'], 'the group holds one Model field, the new form\'s: ' + JSON.stringify(r));
        console.log('PASS an older provider-cards build draws nothing after the dialog opened again (#16404, #16448)');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
