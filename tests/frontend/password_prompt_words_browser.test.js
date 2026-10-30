// The first-run password dialog in plain words (#11258 item 1, the phone NUX pass: 'a password dialog full of jargon'): it says what the password protects (other people and other devices, when Coral is opened in a web
// browser), that it can be skipped on a computer only one person uses, and has ONE clear primary action. No jargon: the tray, a command, 'strict', 'local sign-in'. At 1280 and 390 px. Against a stubbed auth-status.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).startsWith('/api/system/auth-status') ? Promise.resolve(new Response(JSON.stringify({ authenticated: true, method: 'session', password_set: false, local: true }), { status: 200 })) : real(u, o); localStorage.removeItem('coral-password-not-now'); return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'password_ui.js').then(m => m.maybePromptSetPassword()).then(() => true)`);
            await waitFor(`!!document.getElementById('set-password-modal')`, `${w}: the prompt`, 10000);
            const d = await ev(`(() => { const m = document.getElementById('set-password-modal'); const vis = e => e.getClientRects().length > 0;
                return { title: m.querySelector('h3').textContent.trim(), lead: m.querySelector('.pw-lead').textContent.trim(), note: m.querySelector('.pw-not-now').textContent.trim(), text: m.innerText.replace(/\\s+/g, ' '),
                    primary: [...m.querySelectorAll('button.btn-primary')].filter(vis).map(b => b.textContent.trim()), buttons: [...m.querySelectorAll('.modal-footer button')].filter(vis).map(b => ({ t: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height) })) }; })()`);
            assert.equal(d.title, 'Protect Coral with a password', `${w}: the title says what it is`);
            assert.equal(d.lead, 'A password keeps other people and other devices out of Coral when it is opened in a web browser.', `${w}: it says what the password protects`);
            assert.equal(d.note, 'Only you use this computer? You can skip this: the Coral app opens without a password. You can set one later in Settings, Security and privacy.', `${w}: it says it can be skipped on a single-user computer`);
            assert.doesNotMatch(d.text, /\btray\b|open command|strict|local sign-in|\bcli\b/i, `${w}: no jargon: ${d.text}`);
            assert.deepEqual(d.primary, ['Set password'], `${w}: one clear primary action`);
            assert.deepEqual(d.buttons.map(b => b.t), ['Not now', 'Set password'], `${w}: the way out and the one action`);
            if (mobile) assert.ok(d.buttons.every(b => b.h >= 44), `${w}: 44 px targets: ${JSON.stringify(d.buttons)}`);
            await ev(`document.getElementById('set-password-later').click(); true`);
        }
        console.log('PASS the first-run password dialog: plain words, skippable, one primary action');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
