// Coral by keyboard (#10802, Desktop #10800): (1) "Skip to message box" is the first Tab stop of the page, before the top bar and the right panel's tabs (Tab from the page start went through the panel's tabs and the link was
// not the first stop); (2) in New agent step 2 Enter on the persona list goes to Next, as Enter in the folder box does on step 1. At 1280 px; the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const key = (k, code, vk, text) => Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) }).then(() => Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }));
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); true`);
        await key('Tab', 'Tab', 9);
        const first = await ev(`(() => { const a = document.activeElement; return a ? a.tagName.toLowerCase() + '.' + String(a.className).split(' ')[0] + ' ' + (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 30) : 'none'; })()`);
        if (!/skip-link/.test(first)) problems.push(`the first Tab stop is the Skip to message box link (it is ${first})`);
        else {
            const r = await ev(`(() => { const a = document.activeElement.getBoundingClientRect(); return { top: a.top, left: a.left, w: a.width, h: a.height, vh: innerHeight }; })()`);
            if (!(r.w > 20 && r.h > 10 && r.top >= 0 && r.left >= 0)) problems.push(`the link is on the screen when it has the keyboard (${JSON.stringify(r)})`);
        }
        // (2) New agent, step 2: Enter on the persona list is Next
        await ev(`window.showLaunchModal(); true`); await waitFor(`document.querySelector('#launch-modal .modal-content') && document.querySelector('#launch-modal .modal-content').getClientRects().length > 0`, 'the launch dialog', 8000);
        await ev(`window._selectLaunchType('agent'); true`); await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'step 1', 8000);
        await ev(`{ const i = document.getElementById('launch-dir'); i.value = '/tmp/kbd-first'; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('launch-agent-next').click(); } true`);
        await waitFor(`document.getElementById('launch-step-agent').dataset.stage === 'persona'`, 'step 2', 8000);
        await ev(`document.getElementById('launch-persona-select').focus(); true`);
        await key('Enter', 'Enter', 13, '\r');
        try { await waitFor(`document.getElementById('launch-step-agent').dataset.stage === 'agent'`, 'Enter on the persona list goes to step 3', 3000); }
        catch { problems.push('Enter on the persona list goes to Next (it stayed on step 2)'); }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the first keys:\n  ' + problems.join('\n  '));
    console.log('PASS the skip link is the first Tab stop; Enter on the persona list is Next');
})().catch(e => { console.error(e); process.exit(1); });
