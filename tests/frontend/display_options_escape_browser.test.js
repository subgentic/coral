// Escape closes the Agents sidebar's Display options (#15174, Beta walk 7 M4: Esc did not close it; it stayed open and its checkboxes joined the Tab order): opened from the keyboard (the keyboard stays on the Display button), Escape closes it from that button, also after a visit to the panel, and the keyboard stays on the button. 1280 px.
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client, problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const key = async (k, mods = 0) => { const codes = { Tab: 9, Enter: 13, Escape: 27 }, base = { key: k, code: k, windowsVirtualKeyCode: codes[k] || 0, modifiers: mods, ...(k === 'Enter' ? { text: '\r' } : {}) }; await Input.dispatchKeyEvent({ type: 'keyDown', ...base }); await Input.dispatchKeyEvent({ type: 'keyUp', ...base }); };
    const state = () => ev(`(() => { const b = document.querySelector('.sidebar-header[data-header="agents"] [data-display-button]'), p = document.getElementById('display-panel'); return { open: !!p && !p.hidden, expanded: b && b.getAttribute('aria-expanded'), onButton: document.activeElement === b, inPanel: !!p && p.contains(document.activeElement) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`import((window.__coralStatic || '/static/') + 'safe_storage.js').then(({ browserLocal }) => { browserLocal.set('coral-display-panel', '0'); return true; })`).catch(() => {});
        await waitFor(`!!document.querySelector('.sidebar-header[data-header="agents"] [data-display-button]') && document.querySelector('.sidebar-header[data-header="agents"] [data-display-button]').getClientRects().length > 0`, 'the Display button', 10000);
        // open it from the keyboard
        await ev(`document.querySelector('.sidebar-header[data-header="agents"] [data-display-button]').focus(); true`);
        await key('Enter');
        await waitFor(`!document.getElementById('display-panel').hidden`, 'Enter opens Display options', 4000).catch(() => {});
        let s = await state(); check(s.open, 'Enter opens the panel: ' + JSON.stringify(s));
        // opened from the keyboard, the keyboard stays on the Display button: Escape there closes the panel and keeps the keyboard on the button
        await key('Escape'); s = await state();
        check(!s.open && s.expanded === 'false' && s.onButton, 'Escape right after Enter closes the panel: ' + JSON.stringify(s));
        // open again, go back to the button, Escape there
        await key('Enter'); await waitFor(`!document.getElementById('display-panel').hidden`, 'the panel opens again', 4000).catch(() => {});
        await ev(`document.querySelector('.sidebar-header[data-header="agents"] [data-display-button]').focus(); true`);
        s = await state(); check(s.open && s.onButton, 'the keyboard is back on the button, the panel still open: ' + JSON.stringify(s));
        await key('Escape'); s = await state();
        check(!s.open && s.expanded === 'false' && s.onButton, 'Escape on the Display button closes the panel: ' + JSON.stringify(s));
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('display_options_escape_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
