// Ways into a chat from the Inbox (#10400, Desktop pass #10406): the Inbox's side list says what the Inbox is for ("Agents is for chatting now; Inbox is for what needs you and what you did before.") and has a New chat
// button that opens the New agent dialog; an All chats row has "Continue this chat" (it opens the chat and the Resume dialog asks where it goes on); the chat page's button says Continue this chat. 1280 px, isolated dev server, the
// history list stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`!!document.getElementById('inbox-new-chat')`, 'the Inbox side list head', 8000);
        assert.equal(await ev(`document.querySelector('.inbox-nav-hint').textContent.trim()`), 'Agents is for chatting now; Inbox is for what needs you and what you did before.');
        assert.equal(await ev(`document.getElementById('inbox-new-chat').textContent.trim()`), 'New chat');
        assert.equal(await ev(`document.getElementById('btn-resume-session').textContent.trim()`), 'Continue this chat', 'the chat page\'s Resume button says Continue this chat');
        await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
        await ev(`document.getElementById('inbox-new-chat').click(); true`);
        await waitFor(`!!document.getElementById('launch-modal') && getComputedStyle(document.getElementById('launch-modal')).display !== 'none'`, 'New chat opens the New agent dialog', 8000);
        console.log('\nPASS the Inbox says what it is for, has New chat, and a chat says Continue this chat');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
