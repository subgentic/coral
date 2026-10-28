// Settings > Notifications (#10068, desktop #10063 and mobile #10066): each switch says what it does; Desktop alerts never snaps back without a word (a browser that blocks alerts, or a
// permission box that was dismissed, is explained under the switch); the alert kinds and the sound are this browser's own switches that apply while alerts are on. Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const STUB = (perm, ask) => `(() => { function N() {} Object.defineProperty(N, 'permission', { configurable: true, get: () => window.__perm }); window.__perm = ${JSON.stringify(perm)};
        N.requestPermission = async () => { window.__asked = (window.__asked || 0) + 1; window.__perm = ${JSON.stringify(ask)}; return window.__perm; }; window.Notification = N; localStorage.clear(); return true; })()`;
    const open = async () => {
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await require('./helpers/wait').bind(ev).coralReady('startup', 'settings');
    };
    const show = async () => {
        await ev(`(async () => { await window.showSettingsModal('notifications'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none' && !!document.getElementById('settings-desktop-notify')`, 'the Notifications tab');
    };
    const state = () => ev(`(() => { const g = id => document.getElementById(id);
        const note = g('settings-desktop-blocked');
        return { desktop: g('settings-desktop-notify').checked, desktopDisabled: g('settings-desktop-notify').disabled, needs: g('settings-alert-needs-input').checked, reply: g('settings-alert-reply').checked, sound: g('settings-alert-sound').checked,
            kindsDisabled: ['settings-alert-needs-input', 'settings-alert-reply', 'settings-alert-sound'].map(i => g(i).disabled),
            note: note && !note.hidden ? note.textContent : '', labels: [...document.querySelectorAll('#settings-modal .settings-pane:not([hidden]) .sv-label, #settings-modal .settings-pane:not([hidden]) label')].map(l => l.textContent.trim()).filter(Boolean) }; })()`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

        console.log('1. A browser that blocks alerts: said under the switch, and turning it on does not snap back in silence');
        await open();
        await ev(STUB('denied', 'denied'));
        await show();
        let s = await state();
        assert.equal(s.desktop, false);
        assert.match(s.note, /blocks alerts from Coral/, 'the reason is there before the person even tries');
        assert.match(s.note, /site settings/, 'and where to change it');
        assert.deepEqual(s.kindsDisabled, [true, true, true], 'the kinds wait for alerts to be on');
        // a phone has no address bar to look at: its browser's site settings are where the permission is (#10266)
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await open(); await ev(STUB('denied', 'denied')); await show();
        s = await state();
        assert.match(s.note, /blocks alerts from Coral/, '390: the reason is there');
        assert.match(s.note, /site settings/, '390: and where to change it');
        assert.doesNotMatch(s.note, /address bar/, '390: a phone says site settings, not the address bar');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await open(); await ev(STUB('denied', 'denied')); await show();
        s = await state();
        await ev(`document.getElementById('settings-desktop-notify').click(); true`);
        await waitFor(`document.getElementById('settings-desktop-notify').checked === false && !document.getElementById('settings-desktop-blocked').hidden`, 'the switch back off, with the reason shown');
        assert.match((await state()).note, /Allow notifications for this site/);

        console.log('2. A permission box that was dismissed: the switch says what to do');
        await open();
        await ev(STUB('default', 'default'));
        await show();
        s = await state();
        assert.equal(s.note, '', 'no warning before there is anything to say');
        await ev(`document.getElementById('settings-desktop-notify').click(); true`);
        await waitFor(`!document.getElementById('settings-desktop-blocked').hidden`, 'a sentence about the permission');
        s = await state();
        assert.equal(s.desktop, false);
        assert.match(s.note, /choose Allow/);
        assert.equal(await ev(`window.__asked`), 1, 'asked once, from the click');

        console.log('3. Allowed: the switch stays on, the note goes, the kinds and the sound are this browser\'s choices');
        await open();
        await ev(STUB('default', 'granted'));
        await show();
        await ev(`document.getElementById('settings-desktop-notify').click(); true`);
        await waitFor(`document.getElementById('settings-desktop-notify').checked === true`, 'alerts on');
        s = await state();
        assert.equal(s.note, '');
        assert.deepEqual(s.kindsDisabled, [false, false, false]);
        assert.deepEqual([s.needs, s.reply, s.sound], [true, true, false], 'defaults: both kinds, no sound');
        await ev(`document.getElementById('settings-alert-reply').click(); document.getElementById('settings-alert-sound').click(); true`);
        assert.equal(await ev(`localStorage.getItem('coral-alert-finished')`), '0');
        assert.equal(await ev(`localStorage.getItem('coral-alert-sound')`), '1');
        assert.equal(await ev(`localStorage.getItem('coral-alert-needs-input')`), null, 'untouched');
        // reopened: the choices are what the person made
        await show();
        await waitFor(`document.getElementById('settings-alert-reply').checked === false && document.getElementById('settings-alert-sound').checked === true`, 'the dialog filled from what the person chose');
        s = await state();
        assert.deepEqual([s.needs, s.reply, s.sound], [true, false, true]);
        assert.equal(s.desktop, true);
        await ev(`document.getElementById('settings-desktop-notify').click(); true`);
        await waitFor(`document.getElementById('settings-alert-reply').disabled === true`, 'the kinds wait again when alerts are turned off');

        console.log('4. Every switch says what it does');
        s = await state();
        const wanted = ['Show notifications in Coral', 'Desktop alerts', 'Alert when an agent needs input', 'Alert when an agent finishes a reply', 'Play a sound with alerts'];
        for (const w of wanted) assert.ok(s.labels.some(l => l.startsWith(w)), `a switch named "${w}": ${JSON.stringify(s.labels)}`);
        const helps = await ev(`['settings-notify-needs-input', 'settings-desktop-notify', 'settings-alert-sound'].map(i => { const e = document.getElementById(i); const d = (e.getAttribute('aria-describedby') || '').split(' ').map(x => document.getElementById(x)).filter(Boolean).map(x => x.textContent.trim()).join(' '); return d; })`);
        assert.match(helps[0], /when an agent needs input/);
        assert.match(helps[1], /when the tab is hidden/);
        assert.match(helps[2], /alert sound/);
        console.log('PASS Settings > Notifications: what each switch does, a blocked or dismissed permission explained, alert kinds and sound');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
