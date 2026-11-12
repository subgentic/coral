// #15770 (the Operator): Settings > Updates, "Check now" while a check was already downloading (the updater's check lock held) showed "Could not check for updates." three times. Now the card says a check runs and
// offers a disabled Check now; a press the server answers "busy" gets one calm "Already checking" toast (never an error, never one per press); a real failure is still the error.
// A stubbed status and check route on the isolated dev server, 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, settle } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const idle = { enabled: true, relaunch_available: true, installed: '2.0.65', state: 'none', staged: null, relaunch: { available: false, reason: 'nothing_staged', restarts: [], ack: '' }, last_result: null, checked_at: new Date().toISOString(), auto: true, not_ready_reason: 'up_to_date' };
    const STUB = `(() => {
        const real = window.fetch;
        window.__upd = { status: null, check: { status: 202, body: { ok: true } }, presses: 0 };
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (url.includes('/api/cloud/status')) return json({ connected: false, hub_relaunch_updates: false, hub_relaunch_available: true });
            if (url.includes('/api/system/update')) {
                if (url.endsWith('/api/system/update')) return window.__upd.status ? json(window.__upd.status) : json({ error: 'none' }, 404);
                if (url.endsWith('/check')) { window.__upd.presses++; return json(window.__upd.check.body, window.__upd.check.status); }
                if (url.endsWith('/settings')) return json({ ok: true });
            }
            return real(u, o);
        };
        return true; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`import(${S} + 'update_flag.js').then(m => { m.setUpdatesEnabled(true); return true; })`);
        await ev(STUB);
        await ev(`import(${S} + 'update_api.js').then(m => { m.serverHas.check = true; m.serverHas.autoPref = true; return true; })`);
        const setStatus = async st => { await ev(`window.__upd.status = ${JSON.stringify(st)}; import(${S} + 'update_ui.js').then(m => m.startUpdateUi && m.startUpdateUi()).then(() => import(${S} + 'update_ui.js')).then(m => m.refreshUpdateStatus()).then(() => true)`); await settle(ev, 150); };
        const open = async () => { await ev(`window.showSettingsModal('updates'); import(${S} + 'update_settings.js').then(m => m.showUpdatesPane()).then(() => true)`); await settle(ev, 150); /* the pane is drawn from the status each time it is shown */ await waitFor(`!document.getElementById('settings-pane-updates')?.hidden && !!document.querySelector('#update-pane-body .update-status')`, 'the Updates pane', 8000); };
        const card = () => ev(`(() => { const b = document.getElementById('update-pane-body'), a = b.querySelector('.update-act'); return { title: (b.querySelector('.update-status-text b') || {}).textContent, sub: (b.querySelector('.update-status-text p') || {}).textContent, act: a ? a.textContent : null, disabled: a ? a.disabled : null }; })()`);
        const toasts = () => ev(`[...document.querySelectorAll('#toast-host .toast')].map(t => t.textContent.replace(/\\s+/g, ' ').trim())`);

        // 1. a check runs: said, and Check now cannot be pressed again
        await setStatus({ ...idle, checking: true, latest: '2.0.66' }); await open();
        let c = await card();
        assert.equal(c.title, 'Checking for updates…', JSON.stringify(c));
        assert.match(c.sub, /Already checking: downloading Coral 2\.0\.66/, JSON.stringify(c));
        assert.equal(c.act, 'Check now'); assert.equal(c.disabled, true, 'Check now is disabled while a check runs');

        // 2. the server says busy (a check it could not see): three presses give one calm toast, never the error
        await setStatus(idle); await open();
        await ev(`window.__upd.check = { status: 409, body: { code: 'busy', error: 'a check is already running' } }; document.querySelectorAll('#toast-host .toast').forEach(t => t.remove()); true`);
        for (let i = 0; i < 3; i++) {
            await open();
            await ev(`document.querySelector('#update-pane-body .update-act').click(); true`);
            await waitFor(`window.__upd.presses === ${i + 1}`, `press ${i + 1} reached the server`, 6000);
            await settle(ev, 200);
        }
        const said = await toasts();
        assert.ok(!said.some(t => /Could not check/.test(t)), 'a busy check is not an error: ' + JSON.stringify(said));
        assert.equal(said.length, 1, 'one toast at most, however many presses: ' + JSON.stringify(said));
        assert.match(said[0], /Already checking/, said[0]);
        assert.equal(await ev(`document.querySelectorAll('#toast-host .toast.error').length`), 0, 'not drawn as an error');

        // 3. a real failure is still said as one
        await ev(`window.__upd.check = { status: 500, body: { error: 'x' } }; document.querySelectorAll('#toast-host .toast').forEach(t => t.remove()); true`);
        await open();
        await ev(`document.querySelector('#update-pane-body .update-act').click(); true`);
        await waitFor(`[...document.querySelectorAll('#toast-host .toast.error')].some(t => /Could not check for updates\\./.test(t.textContent))`, 'the failure toast', 6000);
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
