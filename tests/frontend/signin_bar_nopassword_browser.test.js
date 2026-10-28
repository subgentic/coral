// The bar that says no password is set (#10061, D2 of the first-run journey, Security's condition c): with strict local auth on and no password the page said nothing once "Not now" was pressed, on a phone as on a desktop.
// Now a bar stays while no password is set: it names what is true, has a real button, Set a password, reachable by keyboard and named for a screen reader, is not dismissible (no close), fits a 390 px phone, opens the
// password form, and goes when a password is set. With sign-in off (strict false) the old words stay and the button joins them while there is no password. The auth-status answer is faked in the page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { axName } = require('./helpers/ax_tree');

const FAKE = `(() => {
    window.__auth = { strict_local_auth: true, password_set: false };
    const inner = window.fetch;
    window.fetch = (url, opts) => {
        if (new URL(String(url), location.origin).pathname === '/api/auth/password/set') { window.__auth = { ...window.__auth, password_set: true }; return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })); }
        if (new URL(String(url), location.origin).pathname !== '/api/system/auth-status') return inner(url, opts);
        return Promise.resolve(new Response(JSON.stringify({ authenticated: true, method: 'session', local: true, ...window.__auth }), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    try { localStorage.setItem('coral-password-not-now', '1'); } catch (e) {} // Not now was pressed: the modal does not open by itself
})();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const recheck = () => ev(`import((window.__coralStatic || '/static/') + 'local_auth_banner.js').then(m => m.checkLocalAuthBanner()).then(() => true)`);
    const bar = () => ev(`(() => { const b = document.getElementById('local-auth-banner'); if (!b) return null; const btn = b.querySelector('button:not([hidden])'), r = b.getBoundingClientRect(); return { shown: !b.hidden && b.checkVisibility({ checkVisibilityCSS: true }), text: b.querySelector('.local-auth-banner-text').innerText.replace(/\\s+/g, ' ').trim(), role: b.getAttribute('role'), buttons: [...b.querySelectorAll('button, [role=button], a')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()), btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0, right: Math.round(r.right), vw: innerWidth }; })()`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: FAKE });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await waitFor(`!document.getElementById('local-auth-banner').hidden`, at + 'the bar when strict is on and no password is set', 15000);
            let b = await bar();
            assert.ok(b.shown && b.role === 'alert' && /No password/.test(b.text) && b.buttons.length === 1 && b.buttons[0] === 'Set a password', at + 'a bar says no password and has one button, Set a password, nothing to close: ' + JSON.stringify(b));
            assert.ok(b.right <= b.vw, at + 'it fits the screen: ' + JSON.stringify(b));
            assert.ok(!/setup code/.test(b.text), at + 'no word about other devices while remote access is off: ' + b.text);
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.privacyStatus = { remote_access_enabled: true }; }); true`); await recheck();
            b = await bar();
            assert.ok(/Other devices sign in with the setup code/.test(b.text), at + 'with remote access on the bar says other devices sign in with the setup code: ' + b.text);
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.privacyStatus = { remote_access_enabled: false }; }); true`); await recheck();
            b = await bar();
            if (mobile) assert.ok(b.btnH >= 44, at + 'the button is a 44 px target: ' + b.btnH);
            await ev(`document.getElementById('local-auth-banner').querySelector('button').setAttribute('data-axp', 'x'); true`);
            const name = await axName(client, '[data-axp="x"]');
            assert.ok(name && name.name === 'Set a password', at + 'its accessible name, as Chrome computes it: ' + JSON.stringify(name));
            // the keyboard reaches it
            await ev(`document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); true`);
            let reached = false;
            for (let i = 0; i < 14 && !reached; i++) {
                await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await sleep(60); // sleep-ok: the key's handlers run
                reached = await ev(`!!document.activeElement && document.activeElement.closest('#local-auth-banner') !== null`);
            }
            assert.ok(reached, at + 'Tab reaches the button within a few presses');
            await shot(`signin-bar-${w}`);
            // it opens the password form
            await ev(`document.getElementById('local-auth-banner').querySelector('button').click(); true`);
            await waitFor(`!!document.getElementById('set-password-modal')`, at + 'the password form', 6000);
            await ev(`document.getElementById('set-password-later').click(); true`); await sleep(200); // sleep-ok: the form closes
            assert.equal(await ev(`!document.getElementById('set-password-modal')`), true);
            // a password is set: the bar goes
            await ev(`window.__auth = { strict_local_auth: true, password_set: true }; document.dispatchEvent(new CustomEvent('coral:password-changed')); true`); await sleep(600); // sleep-ok: the bar asks again
            assert.equal((await bar()).shown, false, at + 'with a password set (and sign-in on) the bar is gone');
            // sign-in off and no password: the old words, and the way to a password
            await ev(`window.__auth = { strict_local_auth: false, password_set: false }; true`); await recheck();
            b = await bar();
            assert.ok(b.shown && /^Sign-in is off:/.test(b.text) && b.buttons.join() === 'Set a password', at + 'sign-in off with no password: the old words and the button: ' + JSON.stringify(b));
            await ev(`window.__auth = { strict_local_auth: false, password_set: true }; true`); await recheck();
            b = await bar();
            assert.ok(b.shown && /^Sign-in is off:/.test(b.text) && b.buttons.length === 0, at + 'sign-in off with a password: the old words, nothing to press: ' + JSON.stringify(b));
            console.log('PASS ' + at + 'the no-password bar');
        }
        // After the password is saved from the form, an open Settings > Security row says Password set at once and the toast is whole on a phone (the beta tester: it still read No password; the toast was cut)
        await ev(`window.__auth = { strict_local_auth: true, password_set: false }; true`);
        await ev(`window.showSettingsModal(); true`);
        await waitFor(`(document.querySelector('#settings-security .tb-now') || {}).textContent === 'No password'`, 'Settings > Security says No password', 8000);
        await ev(`document.getElementById('sec-set').click(); true`);
        await waitFor(`!!document.getElementById('set-password-modal')`, 'the password form from the row', 6000);
        await ev(`for (const id of ['set-password-new', 'set-password-confirm']) { const i = document.getElementById(id); i.value = 'correct horse battery staple 42'; i.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('set-password-save').click(); true`);
        await waitFor(`(document.querySelector('#settings-security .tb-now') || {}).textContent === 'Password set'`, 'the row says Password set after the save', 8000);
        const toast = await ev(`(() => { const t = [...document.querySelectorAll('#notices .notice, .toast, .notification-toast')].find(e => /Password set/.test(e.textContent) && e.getClientRects().length); if (!t) return null; const r = t.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, cut: t.scrollWidth > t.clientWidth + 1 }; })()`);
        assert.ok(toast && toast.left >= 0 && toast.right <= toast.vw && !toast.cut, 'the toast is whole on the phone: ' + JSON.stringify(toast));
        await shot('security-row-password-set-390');
        console.log('PASS Settings says Password set after the save, and the toast is whole');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
