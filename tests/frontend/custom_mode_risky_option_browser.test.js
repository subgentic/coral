// A risky custom mode's picker option carries data-risky (#16777, QA's SHOULD on #16057): New Agent's "Runs as" line reads it, so a custom mode that turns the prompts off gets the amber mode and its warning,
// a safe one does not. Real custom modes saved on the real server, the real option made by custom_modes.js, picked in the real New Agent form. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
        const put = await ev(`fetch('/api/custom-modes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modes: [
            { name: 'Plan only', agent_type: 'claude', flags: ['--permission-mode', 'plan'] },
            { name: 'Wide open', agent_type: 'claude', flags: ['--dangerously-skip-permissions'] }] }) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
        assert.equal(put.status, 200, JSON.stringify(put));
        await ev(`window.showLaunchModal(); window._selectLaunchType('agent'); true`);
        await waitFor(`!!document.querySelector('#launch-agent-acf .acf-permission-mode')`, 'the form');
        await ev(`import((window.__coralStatic || '/static/') + 'custom_modes.js').then(m => m.warmCustomModes(true)).then(() => { const t = document.querySelector('#launch-agent-acf .acf-agent-type'); t.value = 'claude'; t.dispatchEvent(new Event('change', { bubbles: true })); return true; })`);
        await waitFor(`document.querySelectorAll('#launch-agent-acf .acf-permission-mode optgroup[data-custom-modes] option').length === 2`, 'both custom options');
        const opts = await ev(`[...document.querySelectorAll('#launch-agent-acf .acf-permission-mode optgroup[data-custom-modes] option')].map(o => ({ name: o.textContent.replace(/ \\(no prompts\\)$/, ''), risky: o.dataset.risky || '' }))`);
        assert.equal(opts.find(o => o.name === 'Wide open').risky, '1', 'the risky custom option is marked: ' + JSON.stringify(opts));
        assert.equal(opts.find(o => o.name === 'Plan only').risky, '', 'the safe one is not: ' + JSON.stringify(opts));
        const warn = async name => {
            await ev(`(() => { const s = document.querySelector('#launch-agent-acf .acf-permission-mode'); s.value = [...s.options].find(o => o.textContent.startsWith(${JSON.stringify(name)})).value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the recap repaints on the change
            return ev(`({ amber: !!document.querySelector('#launch-recap .runs-as-mode.runs-as-risky'), note: !!document.querySelector('#launch-recap .launch-recap-warn-note') })`);
        };
        const wide = await warn('Wide open'), plan = await warn('Plan only');
        assert.equal(wide.amber, true, 'Runs as is amber for the risky custom mode: ' + JSON.stringify(wide));
        assert.equal(wide.note, true, 'and its warning shows');
        assert.deepEqual(plan, { amber: false, note: false }, 'a safe custom mode shows neither');
        console.log('PASS a risky custom mode shows the amber Runs as warning; a safe one does not');
    } finally { await ev(`fetch('/api/custom-modes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"modes":[]}' }).then(() => true)`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
