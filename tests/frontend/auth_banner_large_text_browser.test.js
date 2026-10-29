// The "No password is set" banner at 200% text on a phone keeps a readable column of words (#11026 item 3, the phone check: its text collapsed to a column one or two letters wide beside the Set a password button, and the
// page could not be used). The banner is shown the way local_auth_banner.js shows it (no password); the words' column must stay at least 10 characters wide, and nothing is wider than the screen. 390 px, touch, 100% and 200% text.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        for (const fs of ['', '32px']) {
            const r = await ev(`(async () => { document.documentElement.style.fontSize = ${JSON.stringify(fs)}; const b = document.getElementById('local-auth-banner'); b.hidden = false; b.classList.remove('notice-error'); b.classList.add('notice-warn');
                for (const s of b.querySelectorAll('[data-auth-state]')) s.hidden = s.dataset.authState !== 'nopw'; document.getElementById('local-auth-set-password').hidden = false; await new Promise(r => setTimeout(r, 300)); /* sleep-ok: the layout settles */
                const t = b.querySelector('.local-auth-banner-text'), ch = parseFloat(getComputedStyle(t).fontSize) * 0.55; return { textW: Math.round(t.getBoundingClientRect().width), chars: Math.round(t.getBoundingClientRect().width / ch), bannerH: Math.round(b.getBoundingClientRect().height), wide: document.documentElement.scrollWidth - innerWidth }; })()`);
            assert.ok(r.chars >= 10, `text ${fs || '100%'}: the words keep a readable column: ` + JSON.stringify(r));
            assert.ok(r.wide <= 1, `text ${fs || '100%'}: nothing wider than the screen: ` + JSON.stringify(r));
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
