// The New agent persona step's More menu closes (#18716, the Operator's shot "the persona button doesn't collapse"): a click or tap outside it, Escape (the focus goes back to More, the dialog stays), and using any action in it each shut it.
// At 1280 and 390. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev); await stubModels(ev);
            await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
            await openNewAgent(ev, waitFor);
            await ev(`(() => { const e = window.__na.find('input', ${N.folder}); e.value = '/work/payments-app'; e.dispatchEvent(new Event('input', { bubbles: true })); window.__na.find('button', ${N.next}).click(); return true; })()`);
            await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, `${label}: step 2`, 6000);
            const D = `document.querySelector('#launch-persona-top details.persona-files')`;
            const open = () => ev(`${D}.querySelector('summary').click(); ${D}.open`);
            const isOpen = () => ev(`${D}.open`);
            assert.equal(await open(), true, `${label}: More opens`);
            await ev(`document.querySelector('#launch-persona-top .launch-persona-lead').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
            await waitFor(`!${D}.open`, `${label}: a press outside shuts it`, 3000);
            await open();
            await ev(`${D}.querySelector('#agent-save-persona-btn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
            assert.equal(await isOpen(), true, `${label}: a press inside it does not shut it`);
            await ev(`${D}.querySelector('summary').focus(); ${D}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`);
            await waitFor(`!${D}.open`, `${label}: Escape shuts it`, 3000);
            assert.equal(await ev(`document.activeElement === ${D}.querySelector('summary')`), true, `${label}: the focus is back on More`);
            assert.equal(await ev(`!!window.__na.dialog()`), true, `${label}: Escape shut the menu, not the dialog`);
            await open();
            await ev(`${D}.querySelector('[data-on-click="m-export-personas"]').click(); true`);
            await waitFor(`!${D}.open`, `${label}: using an action in it shuts it`, 3000);
        }
        console.log('\nPASS the persona More menu closes on an outside press, Escape and an action');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
