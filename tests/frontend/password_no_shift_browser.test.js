// The Set a password dialog does not move the Confirm field while a password is typed (Mobile pass 22, #10281): the strength meter and its line appeared with the first character and pushed Confirm down, so a finger
// aimed at it landed on something else. The space is reserved: the Confirm field's top is the same with nothing typed, one character, a weak password and a strong one, at 390 px, at 200% text and at 1280 px. Drives
// Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, font] of [[390, 844, true, ''], [390, 844, true, '32px'], [1280, 800, false, '']]) {
            const tag = `${w} px${font ? ', 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            if (font) await ev(`document.documentElement.style.fontSize = ${JSON.stringify(font)}; true`);
            await ev(`import((window.__coralStatic || '/static/') + 'password_ui.js').then(m => m.showSetPasswordModal({ local: true })).then(() => true)`);
            await waitFor(`!!document.getElementById('set-password-confirm') && document.getElementById('set-password-confirm').getClientRects().length > 0`, `${tag}: the dialog`, 8000);
            const top = () => ev(`(() => { const c = document.getElementById('set-password-confirm'); const b = c.closest('.modal-body'); return Math.round(c.getBoundingClientRect().top + (b ? b.scrollTop : 0)); })()`);
            const type = v => ev(`(() => { const i = document.getElementById('set-password-new'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            const base = await top();
            for (const [label, v] of [['one character', 'a'], ['a weak password', 'password1'], ['a strong password', 'correct horse battery staple 77!']]) {
                await type(v); await new Promise(r => setTimeout(r, 200)); // sleep-ok: the line is drawn after the input
                const t = await top();
                if (t !== base) problems.push(`${tag}: ${label} moves the Confirm field from ${base} to ${t}`);
            }
            await type(''); await new Promise(r => setTimeout(r, 200)); // sleep-ok: the line is cleared
            const back = await top();
            if (back !== base) problems.push(`${tag}: cleared, the Confirm field is at ${back}, it was at ${base}`);
            await ev(`document.getElementById('set-password-later').click(); true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Set a password dialog:\n  ' + problems.join('\n  '));
    console.log('PASS the Confirm field does not move while a password is typed');
})().catch(e => { console.error(e); process.exit(1); });
