// The provider cards redraw when the CLI checks answer (or give up after 1.5 s, launch_provider_cards.js): a person who is already in the Model row, adding a model say, must stay where they are (#11235 Option B,
// model_picker_add_browser was red under load: the redraw moved the row, the focus went to the page, and Escape no longer closed the add form). The checks here are held back past that time, so the redraw comes
// after the person has the focus in the row, with no load needed. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, openNewAgent, stubModels, stepLine } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev); await stubModels(ev);
        // every CLI check is slower than the picker's own 1.5 s wait, so the cards are drawn again at 1.5 s, whatever the person is doing
        await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => String(u).includes('/api/system/cli-check') ? new Promise(r => setTimeout(() => R(u, o).then(r), 4000)) : R(u, o); return true; })()`);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/tmp'])); true`);
        await openNewAgent(ev, waitFor);
        for (let i = 0; i < 4 && !/Step 3 of 3/.test(await stepLine(ev)); i++) {
            await ev(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(x => /^Next$/.test(x.textContent.trim()) && x.getClientRects().length); const f = document.getElementById('launch-dir'); if (f && !f.value) { f.value = '/tmp'; f.dispatchEvent(new Event('input', { bubbles: true })); } if (b) b.click(); return true; })()`);
            await waitFor(`/Step ${i + 2} of 3|Step 3 of 3/.test(document.querySelector('[role=dialog]')?.textContent || '')`, 'the next step', 4000).catch(() => {});
        }
        await waitFor(`!!document.querySelector('#launch-step-agent .provider-card.is-open .acf-model-select') && document.querySelector('#launch-step-agent .provider-card.is-open .acf-model-select').getClientRects().length > 0`, 'the Model field in the open card', 8000);
        // the cards are built again now (as when the dialog opens), so their 1.5 s wait starts at this moment, however long the steps took to reach
        await ev(`(() => { import((window.__coralStatic || '/static/') + 'launch_provider_cards.js').then(m => m.buildProviderCards({ group: document.getElementById('launch-agent-pick'), form: document.getElementById('launch-agent-acf'), server: 'local', implicitDefault: false })); return true; })()`);
        await waitFor(`!!document.querySelector('#launch-step-agent .provider-card.is-open .acf-model-select')`, 'the Model field in the rebuilt open card', 4000);
        const probed = `document.getElementById('launch-agent-pick').dataset.probed === '1'`;
        assert.equal(await ev(probed), false, 'the cards have not heard from the CLI checks yet');
        await ev(`document.querySelector('#launch-step-agent .provider-card.is-open .acf-model-select').focus(); true`);
        assert.equal(await ev(`document.activeElement.classList.contains('acf-model-select')`), true, 'the person is in the Model field');
        await waitFor(probed, 'the cards drawn again after the wait', 9000);
        const after = await ev(`({ cls: document.activeElement.className, inCard: !!document.activeElement.closest('.provider-card.is-open'), connected: document.activeElement.isConnected })`);
        assert.ok(/acf-model-select/.test(after.cls) && after.inCard && after.connected, `the focus is still in the Model field after the redraw: ${JSON.stringify(after)}`);
        console.log('PASS the provider cards keep a person in the Model row when they are drawn again');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
