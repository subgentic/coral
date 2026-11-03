// When this computer does not let Coral check which account opens a sign-in link, Settings says so in one line in its Status group (#12546, Security); with the check working the line is not there.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, nextFrame } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => {
            window.__lost = false;
            const real = window.fetch;
            window.fetch = async (u, o) => { const r = await real(u, o); if (new URL(String(u), location.href).pathname !== '/api/system/status') return r;
                const d = await r.clone().json(); d.peer_check_unavailable = window.__lost; window.__statusAnswered = (window.__statusAnswered || 0) + 1; return new Response(JSON.stringify(d), { status: r.status, headers: { 'content-type': 'application/json' } }); };
            return true; })()`);
        const line = () => ev(`(() => { const e = document.getElementById('peer-check-line'); return e ? { hidden: e.hidden, text: e.textContent, role: e.getAttribute('role') } : null; })()`);
        const open = async () => { const before = await ev(`window.__statusAnswered || 0`); await ev(`(async () => { await window.showSettingsModal('network'); return true; })()`); await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, 'the settings dialog'); await waitFor(`(window.__statusAnswered || 0) > ${before}`, 'the status request'); };

        await open();
        await nextFrame(ev); // the status handler has run (bounded frames, not a fixed sleep)
        let l = await line();
        assert.ok(l, 'the line is in the Status group');
        assert.equal(l.hidden, true, 'the check works: nothing is said');
        assert.equal(l.text, '');
        await ev(`window.__lost = true; true`); // the next opening asks the status again

        await open();
        await waitFor(`document.getElementById('peer-check-line').textContent !== ''`, 'the line is filled');
        l = await line();
        assert.equal(l.hidden, false);
        assert.equal(l.role, 'status');
        assert.match(l.text, /does not let Coral check which account opens a sign-in link/);
        assert.match(l.text, /once, for ten minutes/);
        assert.equal(await ev(`document.getElementById('peer-check-line').closest('#about-section') !== null`), true, 'it sits in the Status group, beside the version');
    } finally { await client.close(); }
    console.log('settings_peer_check_line_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
