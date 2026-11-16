// #17538: Settings > Updates shows the running version at the top and a Check now button whose result stays on screen (not a toast).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

const idle = (over = {}) => ({ enabled: true, installed: '2.0.70', state: 'none', staged: null, relaunch: { available: false, reason: 'nothing_staged', restarts: [], ack: '' }, last_result: null, not_ready_reason: 'up_to_date', ...over });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const settle = ms => new Promise(r => setTimeout(r, ms));
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`import(${S} + 'update_flag.js').then(m => { m.setUpdatesEnabled(true); return true; })`);

        // stub /api/system/update and /api/system/update/check
        let checkCalled = false;
        await ev(`(() => { const R = window.fetch; window.__st = ${JSON.stringify(idle())};
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname;
                if (p === '/api/system/update') return Promise.resolve(new Response(JSON.stringify(window.__st), { status: 200, headers: { 'content-type': 'application/json' } }));
                if (p === '/api/system/update/check') { window.__checkCalled = true; return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })); }
                if (p === '/api/cloud/status') return Promise.resolve(new Response(JSON.stringify({ connected: false }), { status: 200, headers: { 'content-type': 'application/json' } }));
                return R(u, o); }; return true; })()`);

        // refresh the cached status from the stub, then open the Updates pane
        await ev(`import(${S} + 'update_ui.js').then(m => m.refreshUpdateStatus()).then(() => true)`);
        await ev(`(async () => { await window.showSettingsModal('updates'); const m = await import(${S} + 'update_settings.js'); await m.showUpdatesPane(); return true; })()`);
        await settle(300);

        // 1. version is shown at the top
        const ver = await ev(`(() => { const el = document.querySelector('#update-pane-body .update-version-value'); return el ? el.textContent : null; })()`);
        assert.ok(ver, 'the version row exists');
        assert.match(ver, /2\.0\.70/, 'the version text shows the installed version');

        // 2. Check now button exists
        const btn = await ev(`(() => { const b = document.querySelector('#update-pane-body .update-check-inline'); return b ? { text: b.textContent, disabled: b.disabled, type: b.type } : null; })()`);
        assert.ok(btn, 'the Check now button exists');
        assert.equal(btn.text, 'Check now', 'the button says Check now');
        assert.equal(btn.disabled, false, 'the button is enabled');

        // 3. clicking Check now: result appears inline, no toast
        await ev(`window.__checkCalled = false; document.querySelector('#update-pane-body .update-check-inline').click(); true`);
        await settle(500);
        checkCalled = await ev(`window.__checkCalled`);
        assert.equal(checkCalled, true, 'POST /api/system/update/check was called');

        // the pane redraws (showUpdatesPane is called after the check); version is still at the top
        const verAfter = await ev(`(() => { const el = document.querySelector('#update-pane-body .update-version-value'); return el ? el.textContent : null; })()`);
        assert.ok(verAfter, 'the version row is still there after the check');

        // no update toast appeared (the result stays in the pane, not a toast)
        const toast = await ev(`!!document.getElementById('update-toast')`);
        assert.equal(toast, false, 'no update toast appeared');

        // 4. a too-soon check shows an inline error
        await ev(`(() => { const R = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname;
            if (p === '/api/system/update/check') return Promise.resolve(new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }));
            return window.fetch.__orig(u, o); }; window.fetch.__orig = R; return true; })()`);
        await ev(`(async () => { await window.showSettingsModal('updates'); const m = await import(${S} + 'update_settings.js'); await m.showUpdatesPane(); return true; })()`);
        await settle(300);
        await ev(`document.querySelector('#update-pane-body .update-check-inline').click(); true`);
        await settle(500);
        const result = await ev(`(() => { const el = document.getElementById('update-check-result'); return el ? el.textContent : ''; })()`);
        assert.match(result, /moment ago|minute/i, 'a too-soon check shows the reason inline');

        console.log('PASS Settings > Updates: version and Check now (#17538)');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
