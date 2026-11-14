// Desktop alerts: the toggle never shows ON while the browser permission is pending (#16839, walk 34 F6).
// A gated requestPermission stub exposes the mid-wait state; the toggle must be OFF with a note until the browser answers.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const GATE = (finalPerm) => `(() => {
        window.__gateResolve = null;
        window.__gatePromise = new Promise(r => { window.__gateResolve = r; });
        function N() {}
        Object.defineProperty(N, 'permission', { configurable: true, get: () => window.__perm });
        window.__perm = 'default';
        N.requestPermission = () => window.__gatePromise.then(() => { window.__perm = ${JSON.stringify(finalPerm)}; return window.__perm; });
        window.Notification = N;
        localStorage.clear();
        return true;
    })()`;
    const open = async () => {
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await require('./helpers/wait').bind(ev).coralReady('startup', 'settings');
    };
    const show = async () => {
        await ev(`(async () => { await window.showSettingsModal('notifications'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none' && !!document.getElementById('settings-desktop-notify')`, 'the Notifications tab');
    };
    const state = () => ev(`(() => { const g = id => document.getElementById(id); const note = g('settings-desktop-blocked');
        return { desktop: g('settings-desktop-notify').checked, kindsDisabled: ['settings-alert-needs-input', 'settings-alert-reply', 'settings-alert-sound'].map(i => g(i).disabled),
            note: note && !note.hidden ? note.textContent : '' }; })()`);

    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

        console.log('1. While the permission prompt is open, the toggle is OFF and a note says why');
        await open();
        await ev(GATE('granted'));
        await show();
        await ev(`document.getElementById('settings-desktop-notify').click(); true`);
        let s = await state();
        assert.equal(s.desktop, false, 'the toggle is OFF while the browser is being asked, not ON (#16839)');
        assert.ok(s.note.length > 0, 'a note explains the pending state');
        assert.deepEqual(s.kindsDisabled, [true, true, true], 'the alert kinds stay disabled while the toggle is off');
        await ev(`window.__gateResolve(); true`);
        await waitFor(`document.getElementById('settings-desktop-notify').checked === true`, 'the toggle ON after the browser grants');
        s = await state();
        assert.equal(s.desktop, true);
        assert.equal(s.note, '');
        assert.deepEqual(s.kindsDisabled, [false, false, false], 'the kinds enabled after grant');

        console.log('2. Permission denied: the toggle stays OFF with a reason');
        await open();
        await ev(GATE('denied'));
        await show();
        await ev(`document.getElementById('settings-desktop-notify').click(); true`);
        s = await state();
        assert.equal(s.desktop, false, 'OFF while asking');
        await ev(`window.__gateResolve(); true`);
        await waitFor(`/Allow|blocked/i.test((document.getElementById('settings-desktop-blocked') || {}).textContent || '')`, 'the denial reason');
        s = await state();
        assert.equal(s.desktop, false, 'OFF after denial');
        assert.match(s.note, /Allow|blocked/i, 'the reason says where to allow');

        console.log('3. Permission dismissed (resolves to default): the toggle stays OFF');
        await open();
        await ev(GATE('default'));
        await show();
        await ev(`document.getElementById('settings-desktop-notify').click(); true`);
        s = await state();
        assert.equal(s.desktop, false, 'OFF while asking');
        await ev(`window.__gateResolve(); true`);
        await waitFor(`/choose Allow/i.test((document.getElementById('settings-desktop-blocked') || {}).textContent || '')`, 'the dismissed reason');
        s = await state();
        assert.equal(s.desktop, false, 'OFF after dismissal');
        assert.match(s.note, /choose Allow/i);

        console.log('PASS Desktop alerts: toggle OFF while permission pending, grant, deny, dismiss (#16839)');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
