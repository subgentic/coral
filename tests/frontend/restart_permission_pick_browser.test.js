// The mode picked in the Restart dialog is the mode the agent restarts in (#12481). The dialog sent the pick only as a flag in extra_flags, which the server strips, so Default to Bypass gave no flag and
// Bypass to Default kept the stored one (no prompts although the person chose them). The dialog now opens on the mode the agent runs in and sends `permission_mode` only when the person changed it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => {
            window.__reqs = [];
            const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                if (m === 'POST' && /^\\/api\\/sessions\\/live\\/[^/]+\\/restart$/.test(p.pathname)) { window.__reqs.push(JSON.parse(o.body)); return json({ session_id: 'sid-r2', session_name: 'ag-r' }); }
                return real(u, o); };
            await window.showLaunchModal(); window.hideLaunchModal();
            return true; })()`);
        const settled = () => waitFor(`document.getElementById('restart-acf').dataset.acfDefaults !== 'pending'`, 'the form default model has arrived', 8000);
        const run = async (storedMode, pick, liveOnly = false, live = '') => {
            const session = { name: 'ag', display_name: 'Agent', session_id: 'sid-r', type: 'live', agent_type: 'claude', model: 'claude-opus-4', prompt: 'p', tmux_session: 'ag' };
            if (liveOnly) session.live_permission_mode = storedMode; else session.permission_mode = storedMode;
            if (live) session.live_permission_mode = live; // an agent whose row has only the CLI's own report (a hook) opens on it too
            const n = await ev(`window.__reqs.length`);
            await ev(`T.state.liveSessions = [${JSON.stringify(session)}]; window.selectLiveSession('ag', 'claude', 'sid-r', 'local'); true`); // the real selection path: it is what puts the agent's mode on the page's session
            await waitFor(`T.state.currentSession && T.state.currentSession.session_id === 'sid-r'`, 'the agent is selected');
            await ev(`window.restartSession(); true`);
            await waitFor(`getComputedStyle(document.getElementById('restart-modal')).display !== 'none' && !!document.querySelector('#restart-acf .acf-permission-mode')`, 'the restart dialog');
            await settled();
            const opened = await ev(`document.querySelector('#restart-acf .acf-permission-mode').value`);
            if (pick) await ev(`(() => { const e = document.querySelector('#restart-acf .acf-permission-mode'); e.value = ${JSON.stringify(pick)}; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await ev(`(document.querySelector('#restart-modal [data-on-click="m-confirm-restart"]')).click(); true`);
            await waitFor(`window.__reqs.length > ${n}`, 'the restart request', 8000);
            return { opened, note: await ev(`(document.querySelector('#restart-acf .acf-mode-live') || {}).textContent || ''`), body: await ev(`window.__reqs[${n}]`) };
        };
        const bypassUntouched = await run('bypassPermissions', null);
        assert.equal(bypassUntouched.opened, 'bypassPermissions', 'the dialog opens on the mode the agent runs in, not the saved default');
        assert.equal(bypassUntouched.body.permission_mode, undefined, 'a restart that does not touch the select sends no mode: the stored one stands');
        const toDefault = await run('bypassPermissions', 'default');
        assert.equal(toDefault.body.permission_mode, 'default', 'Bypass to Default sends Default (the unsafe direction: the stored --yolo or skip flag must not survive)');
        const toBypass = await run('default', 'bypassPermissions');
        assert.equal(toBypass.opened, 'default');
        assert.equal(toBypass.body.permission_mode, 'bypassPermissions', 'Default to Bypass sends Bypass');
        const liveToDefault = await run('bypassPermissions', 'default', true);
        assert.equal(liveToDefault.opened, 'bypassPermissions', 'a row with only the live mode opens on it');
        assert.equal(liveToDefault.body.permission_mode, 'default', 'Bypass to Default is sent when the mode came from the live report');
        const both = await run('default', null, false, 'plan');
        assert.equal(both.opened, 'default', 'stored and live differ: the dialog opens on the mode a restart will use (the stored one)');
        assert.equal(both.note, 'Running in Plan now; restarting uses Default unless you pick.', 'and says what the agent runs in now');
        assert.equal(both.body.permission_mode, undefined, 'untouched: no mode is sent');
        const same = await run('plan', null, false, 'plan');
        assert.equal(same.note, '', 'no note when the two agree');
    } finally { await client.close(); }
    console.log('restart_permission_pick_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
