// Find in conversation (Ctrl/Cmd+F) also works in the Inbox's past-chat view (#10533 point 3, the Desktop tester): it searched only the live chat, so on a past chat the key did nothing. The past chat's box is filled
// by hand here (two messages); the find bar opens, counts the matches and steps through them. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`(async () => { const u = await import((window.__coralStatic || '/static/') + 'utils.js'); u.showView('history-session-view'); const box = document.getElementById('history-messages');
            box.innerHTML = '<div class="chat-bubble human"><div class="role-label">You</div><div class="message-text">please fix the flaky login test</div></div><div class="chat-bubble assistant"><div class="role-label">Claude</div><div class="message-text">the login test is fixed; the login page is slower</div></div>'; return true; })()`);
        await waitFor(`document.getElementById('history-messages').offsetParent !== null`, 'the past chat is on screen', 8000);
        await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: 2 });
        await waitFor(`!!document.querySelector('.chat-find-bar') && !document.querySelector('.chat-find-bar').hidden`, 'Ctrl+F opens the find bar on a past chat', 4000);
        await ev(`(() => { const i = document.querySelector('.chat-find-input'); i.value = 'login'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await waitFor(`/1 of 3|of 3/.test(document.querySelector('.chat-find-count').textContent)`, 'the matches are counted', 4000);
        assert.equal(await ev(`document.querySelector('.chat-find-older').hidden`), true, 'a past chat has no older pages to fetch');
        console.log('PASS Find in conversation works in a past chat');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
