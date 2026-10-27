// An old Chats link in the Hub's native Inbox (Goal #100, #9549, #9559): with the boot value inbox:'native' there is no Chats tab, and an address from the days of one still works. /chats/@<server>/<id> lands on that chat in
// the Inbox (/inbox/chats/all/@<server>/<id>) as a replace: one history entry for the visit, Back leaves the dashboard's page and does not bounce; /chats?starred=1 lands on the Starred folder; a chat that is not there
// leaves All chats on screen and says "That chat was not found". The stubbed two-computer Hub of helpers/hub_world.js (native boot), at desktop width; shots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { FOLDER_ROWS, ROW_WORDS } = require('./helpers/folder_rows');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); await settle(300); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = async path => { await Page.navigate({ url: BASE + path }); await Page.loadEventFired(); await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard'); await ev(`window.__coralReady.startup('liveList', 'settings')`); };
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, native: true });
        await open('/');
        assert.equal(await ev(`document.body.classList.contains('native-inbox')`), true, 'the Hub boots the native Inbox');
        assert.equal(await ev(`['nav-tab-history', 'nav-tab-board'].every(id => getComputedStyle(document.getElementById(id)).display === 'none')`), true, 'there is no Chats or Board tab');
        const before = await ev(`history.length`);
        const home = await ev(`location.pathname`);

        console.log('1. an old chat link lands on that chat in the Inbox, one history entry');
        await open('/chats/@m1/same-chat');
        await waitFor(`location.pathname === '/inbox/chats/all/@m1/same-chat'`, 'the old link is the Inbox address of the chat', 15000);
        await waitFor(`!!document.getElementById('history-session-view') && document.getElementById('history-session-view').checkVisibility() && /needle from m1/.test(document.getElementById('history-session-view').textContent)`, 'the chat of the Laptop is on screen', 15000);
        assert.equal(await ev(`history.length`), before + 1, 'the visit is one history entry: the redirect replaced the old address');
        await shot('native-inbox-old-chat-link');
        await ev(`history.back(); true`);
        await waitFor(`location.pathname === ${JSON.stringify(home)}`, 'Back leaves for the page before the link', 8000);
        await settle(800);
        assert.equal(await ev(`location.pathname`), home, 'and stays there: no bounce back to the chat');

        console.log('2. /chats?starred=1 lands on the Starred folder');
        await open('/chats?starred=1');
        await waitFor(`location.pathname === '/inbox/chats/starred'`, 'the old filter link is the Starred folder', 15000);
        await waitFor(`[...document.querySelectorAll('.view-list-item')].some(b => b.getAttribute('aria-current') && (${ROW_WORDS})(b).startsWith('Starred'))`, 'Starred is the folder on screen', 15000);
        await shot('native-inbox-old-starred-link');

        console.log('3. a chat that is not there leaves All chats on screen and says so');
        await open('/chats/@m1/no-such-chat');
        await waitFor(`location.pathname === '/inbox/chats/all'`, 'an unknown chat lands on All chats, not a not-found page', 15000);
        await waitFor(`[...document.querySelectorAll('.toast, [role=alert], [role=status]')].some(e => /That chat was not found/.test(e.textContent))`, 'the page says "That chat was not found"', 15000);
        assert.ok(await ev(`${FOLDER_ROWS}.some(w => /^All chats/.test(w))`), 'the Inbox folders are on screen');
        await shot('native-inbox-old-unknown-chat');
        console.log('PASS native Inbox old links: a chat lands in the Inbox with one history entry and Back leaves, ?starred=1 is Starred, an unknown chat says so on All chats');
    } catch (e) { console.error(e && e.stack || e); process.exitCode = 1; }
    try { await client.close(); } catch (_) {}
})();
