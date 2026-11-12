// #15771 (the Operator's bug): Settings > Updates drew the last status, up to ten minutes old, so a release staged since then still read "Coral is up to date" with only Check now. The pane now reads the
// status again while it is open and draws the card again when it changed: a release staged while the pane is open turns the card into "Coral 2.0.66 is ready" with the Update and relaunch button, with no reload and
// no click; one that is already staged when the pane opens shows at once even if the page's last status was older. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const staged = { enabled: true, relaunch_available: true, installed: '2.0.65', state: 'staged', staged: { version: '2.0.66', staged_at: '2026-11-12T03:56:00Z', days_ready: 0, verified: true }, relaunch: { available: true, reason: '', restarts: [], ack: 'x' }, last_result: null };
const upToDate = { enabled: true, relaunch_available: true, installed: '2.0.65', state: 'none', staged: null, relaunch: { available: false, reason: 'nothing_staged', restarts: [], ack: '' }, last_result: null, not_ready_reason: 'up_to_date' };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`localStorage.clear(); true`);
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`import(${S} + 'update_flag.js').then(m => { m.setUpdatesEnabled(true); return true; })`);
        await ev(`(() => { const R = window.fetch; window.__st = ${JSON.stringify(upToDate)};
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname;
                if (p === '/api/system/update') return Promise.resolve(new Response(JSON.stringify(window.__st), { status: 200, headers: { 'content-type': 'application/json' } }));
                if (p === '/api/cloud/status') return Promise.resolve(new Response(JSON.stringify({ connected: false }), { status: 200, headers: { 'content-type': 'application/json' } }));
                return R(u, o); }; return true; })()`);
        await ev(`import(${S} + 'update_ui.js').then(m => m.refreshUpdateStatus()).then(() => true)`);
        await ev(`window.showSettingsModal('updates'); true`);
        await waitFor(`!!document.getElementById('update-pane-body')`, 'the Updates pane is open', 8000);
        await ev(`import(${S} + 'update_settings.js').then(m => m.showUpdatesPane()).then(() => true)`);
        const card = () => ev(`(document.querySelector('#update-pane-body .update-status') || {}).textContent || ''`);
        await waitFor(`/Coral is up to date/.test((document.querySelector('#update-pane-body .update-status') || {}).textContent || '')`, 'the pane says up to date first', 8000);
        // the check staged a release meanwhile (the tray's, or the automatic one): nothing in the page asked for it
        await ev(`window.__st = ${JSON.stringify(staged)}; true`);
        await waitFor(`/Coral 2\\.0\\.66 is ready/.test((document.querySelector('#update-pane-body .update-status') || {}).textContent || '')`, 'the card turns into "ready" without a reload', 15000);
        const t = await card();
        assert.match(t, /Update and relaunch|Relaunch/i, 'the install button is on the card: ' + t);
        assert.doesNotMatch(t, /up to date/i);
        // and a pane opened with an older status in the page's memory shows the staged release at once
        await ev(`window.__st = ${JSON.stringify(upToDate)}; import(${S} + 'update_ui.js').then(m => m.refreshUpdateStatus()).then(() => true)`);
        await ev(`window.__st = ${JSON.stringify(staged)}; import(${S} + 'update_settings.js').then(m => m.showUpdatesPane()).then(() => true)`);
        await waitFor(`/Coral 2\\.0\\.66 is ready/.test((document.querySelector('#update-pane-body .update-status') || {}).textContent || '')`, 'an old status in memory does not hold the pane back', 15000);
        console.log('PASS the Updates pane follows a release being staged');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
