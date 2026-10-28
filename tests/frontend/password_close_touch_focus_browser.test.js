// Closing or finishing the Set a password dialog on a touch screen does not raise the keyboard (Mobile pass 22, #10281): focus went to the agent search box, whose focus opens the on-screen keyboard over a page nobody had
// looked at. On a coarse pointer it goes to the page's heading (Home's, "What do you want to work on?"); with a mouse it is still Home's first control. At 390 px with touch and at 1280 px with a mouse; Not now and Escape.
// Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const where = () => ev(`(() => { const a = document.activeElement; return !a || a === document.body ? 'the page (nothing)' : a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + ' ' + (a.textContent || a.placeholder || '').replace(/\\s+/g, ' ').trim().slice(0, 30); })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, touch, want] of [[390, 844, true, /^h[12] What do you want to work on/], [1280, 800, false, /^button .*New agent/]]) {
            for (const closeBy of ['Not now', 'Escape']) {
                const check = (ok, msg) => { if (!ok) problems.push(`${w}, ${closeBy}: ${msg}`); };
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: touch }); await Emulation.setTouchEmulationEnabled({ enabled: touch });
                await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
                await ev(`window.__coralReady.startup('liveList', 'settings')`);
                await ev(`document.activeElement && document.activeElement.blur(); import((window.__coralStatic || '/static/') + 'password_ui.js').then(m => { m.showSetPasswordModal({ local: true }); return true; })`);
                await waitFor(`!!document.getElementById('set-password-modal')`, `${w}: the dialog`, 8000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the dialog draws
                if (closeBy === 'Escape') { await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); }
                else await ev(`document.getElementById('set-password-later').click(); true`);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the dialog closes
                const got = await where();
                check(want.test(got), `the keyboard is on ${want} (it is on ${got})`);
                check(!/search/i.test(got), `not on a search box, whose focus raises a phone's keyboard (${got})`);
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Set a password dialog and the keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS closing the Set a password dialog raises no keyboard on touch');
})().catch(e => { console.error(e); process.exit(1); });
