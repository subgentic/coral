// Ways into a chat from the Inbox (#10400, Desktop pass #10406; the operator took the Inbox side list's hint and its New chat button out, #10674): the Inbox's side list has neither the line "Agents is for chatting now; ..." nor a
// New chat button; an All chats row has "Continue this chat" (it opens the chat and the Resume dialog asks where it goes on); the chat page's button says Continue this chat. 1280 px, isolated dev server, the history list stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`!!document.getElementById('inbox-nav-list')`, 'the Inbox side list', 8000);
        assert.equal(await ev(`!!document.querySelector('.inbox-nav-hint') || !!document.getElementById('inbox-new-chat') || /Agents is for chatting|New chat/.test(document.querySelector('[data-pane="hub-inbox"]').textContent)`), false, 'the Inbox side list has no hint line and no New chat button');
        assert.equal(await ev(`document.getElementById('btn-resume-session').textContent.trim()`), 'Continue this chat', 'the chat page\'s Resume button says Continue this chat');
        await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
        await waitFor(`document.querySelectorAll('#inbox-nav-list .view-list-item').length > 0`, 'the Inbox folders', 8000);
        assert.equal(await ev(`/Agents is for chatting|New chat/.test(document.querySelector('[data-pane="hub-inbox"]').textContent)`), false, 'and still none with the Inbox open');
        console.log('\nPASS the Inbox side list has no hint and no New chat; a chat says Continue this chat');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
