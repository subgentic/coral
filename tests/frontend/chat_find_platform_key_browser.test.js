// Find in conversation answers the platform's own key only (#15798, the Operator: Cmd+F and Ctrl+F both opened it): Cmd+F on macOS, Ctrl+F elsewhere. On a Mac Ctrl+F is left alone (the text box's: Emacs
// "forward one character"); on Windows and Linux Cmd/Win+F is left alone. Both platforms are driven in one browser by setting platform.isMacOS, with the past chat's box on screen; Cmd/Ctrl+Enter send is not touched.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const key = async modifiers => { await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers }); };
    const open = () => ev(`!!document.querySelector('.chat-find-bar') && !document.querySelector('.chat-find-bar').hidden`);
    const close = () => ev(`(window.closeChatFind && window.closeChatFind(), true)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(async () => { const u = await import((window.__coralStatic || '/static/') + 'utils.js'); u.showView('history-session-view'); document.getElementById('history-messages').innerHTML = '<div class="chat-bubble human"><div class="message-text">find me</div></div>'; return true; })()`);
        await waitFor(`document.getElementById('history-messages').offsetParent !== null`, 'the past chat is on screen', 8000);
        const setMac = mac => ev(`import((window.__coralStatic || '/static/') + 'platform/detect.js').then(m => { m.platform.isMacOS = ${mac}; return true; })`);
        const CTRL = 2, META = 4;
        for (const [mac, own, other, ownName, otherName] of [[true, META, CTRL, 'Cmd+F', 'Ctrl+F'], [false, CTRL, META, 'Ctrl+F', 'Cmd+F']]) {
            const at = (mac ? 'macOS: ' : 'Windows/Linux: ');
            await setMac(mac); await close();
            await key(other); await new Promise(r => setTimeout(r, 300)); // sleep-ok: proving nothing happens needs a quiet period
            assert.equal(await open(), false, at + otherName + ' leaves the page alone');
            await key(own);
            await waitFor(`!!document.querySelector('.chat-find-bar') && !document.querySelector('.chat-find-bar').hidden`, at + ownName + ' opens the find bar', 4000);
            await close();
        }
        console.log('PASS find in conversation: Cmd+F on macOS, Ctrl+F elsewhere, never the other');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
