// The amber 'No password is set' banner (#11258 item 2, the phone NUX pass): it stayed on every page of a new install. It can be dismissed with a button, and that is remembered on this browser; a quiet 'No password' row stays in
// Settings > Security. It comes back if a password is set and later removed. The red 'Sign-in is off' banner is a risk, not a nudge: it has no dismiss and ignores the memory. Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

const FAKE = `(() => {
    window.__auth = { strict_local_auth: true, password_set: false };
    const inner = window.fetch;
    window.fetch = (url, opts) => {
        if (new URL(String(url), location.origin).pathname !== '/api/system/auth-status') return inner(url, opts);
        return Promise.resolve(new Response(JSON.stringify({ authenticated: true, method: 'session', local: true, ...window.__auth }), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
})();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const ok = name => console.log(`   ✓ ${name}`);
    const shown = () => ev(`(() => { const b = document.getElementById('local-auth-banner'); return !!b && !b.hidden && b.checkVisibility({ checkVisibilityCSS: true }); })()`);
    const dismissBtn = () => ev(`(() => { const x = document.getElementById('local-auth-dismiss'); return x ? { shown: !x.hidden && x.getClientRects().length > 0, name: (x.getAttribute('aria-label') || x.textContent).trim(), h: Math.round(x.getBoundingClientRect().height) } : null; })()`);
    const load = async () => { await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: FAKE });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            console.log(`${w} px`);
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await load();
            await ev(`localStorage.removeItem('coral-nopw-banner-dismissed'); true`);
            await load();
            await waitFor(`!document.getElementById('local-auth-banner').hidden`, `${w}: the no-password banner shows on a new install`, 15000);
            assert.equal(await shown(), true);
            const d = await dismissBtn();
            assert.ok(d && d.shown && /Dismiss/i.test(d.name), `${w}: it can be dismissed: ${JSON.stringify(d)}`);
            if (mobile) assert.ok(d.h >= 44, `${w}: a 44 px target (${d.h} px)`);
            await ev(`document.getElementById('local-auth-dismiss').click(); true`);
            await waitFor(`document.getElementById('local-auth-banner').hidden`, `${w}: dismissed`, 8000);
            ok('shown on a new install, dismissed with a button');
            await load();
            await new Promise(r => setTimeout(r, 1500)); // sleep-ok: the first auth-status read is in once the banner would have appeared
            assert.equal(await shown(), false, `${w}: it stays gone after a reload (remembered)`);
            ok('remembered across a reload');
            // sign-in off is a risk: no dismiss, and the memory does not hide it
            await ev(`window.__auth = { strict_local_auth: false, password_set: false }; document.dispatchEvent(new Event('coral:password-changed')); true`);
            await waitFor(`!document.getElementById('local-auth-banner').hidden`, `${w}: the sign-in-off banner ignores the memory`, 8000);
            assert.equal((await dismissBtn()).shown, false, `${w}: the red banner has no dismiss`);
            ok('the red sign-in-off banner has no dismiss and ignores the memory');
            // a password is set, then removed: the nudge comes back
            await ev(`window.__auth = { strict_local_auth: true, password_set: true }; document.dispatchEvent(new Event('coral:password-changed')); true`);
            await waitFor(`document.getElementById('local-auth-banner').hidden`, `${w}: password set: no banner`, 8000);
            await ev(`window.__auth = { strict_local_auth: true, password_set: false }; document.dispatchEvent(new Event('coral:password-changed')); true`);
            await waitFor(`!document.getElementById('local-auth-banner').hidden`, `${w}: password removed: the nudge is back`, 8000);
            ok('a password set and later removed brings the nudge back');
        }
        console.log('PASS the no-password banner is dismissible and remembered; sign-in off stays');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
