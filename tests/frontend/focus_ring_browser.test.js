// One focus style (#15175, walk 7 M7): a text field, a select, a summary toggle and a button each show the same 2 px accent ring when focus comes by keyboard, in the dark and the light theme.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(() => { const host = document.body.appendChild(document.createElement('div')); host.id = 'focus-probe'; document.head.appendChild(document.createElement('style')).textContent = '#focus-probe * { transition: none !important }'; host.innerHTML = '<input class="field" id="fp-input" aria-label="probe field"><select class="field" id="fp-select" aria-label="probe select"><option>One</option></select><details><summary id="fp-summary">Probe summary</summary>text</details><button class="btn" id="fp-button" type="button">Probe</button>'; return true; })()`);
        for (const theme of ['dark', 'light']) {
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            const ring = id => ev(`(() => { const e = document.getElementById('${id}'); e.focus(); const c = getComputedStyle(e); return { w: c.outlineWidth, s: c.outlineStyle, color: c.outlineColor, shadow: c.boxShadow }; })()`);
            // a key press makes the focus a keyboard focus (:focus-visible)
            await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
            const rings = {};
            for (const id of ['fp-button', 'fp-input', 'fp-select', 'fp-summary']) rings[id] = await ring(id);
            for (const id of ['fp-input', 'fp-select', 'fp-summary']) assert.deepEqual({ w: rings[id].w, s: rings[id].s, color: rings[id].color }, { w: rings['fp-button'].w, s: rings['fp-button'].s, color: rings['fp-button'].color }, `${theme}: ${id} has the same ring as a button: ` + JSON.stringify(rings));
            assert.equal(rings['fp-button'].w, '2px', `${theme}: the ring is 2 px`);
        }
        console.log('PASS focus ring');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
