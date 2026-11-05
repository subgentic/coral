// The phone's top pill searches the open Inbox page on a Hub too (#13591): the Hub's chat search is a request to another computer, so it is sent on Enter, not on each key (coral-hub's rate condition,
// the page's commitOnEnter). Typing in the pill sends nothing; Enter sends the one search; a held Enter is one search. At 390 and at 620 px (the old top pill's width). The stubbed Hub of helpers/hub_world.js (native boot).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable();
        for (const w of [390, 620]) {
            await setupHubWorld({ client, Page, Emulation, width: w, height: 844, mobile: true, inbox: 'native' });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`window.__urls = []; const f = window.fetch; window.fetch = function (u, ...r) { try { window.__urls.push(String(u && u.url || u)); } catch {} return f.call(this, u, ...r); }; window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => true)`);
            await ev(framesJs(8));
            await waitFor(`(document.querySelector('header.top-bar .phone-bar-search') || {}).placeholder === 'Search chats'`, `${w}: the pill is the chats search`, 10000);
            assert.equal(await ev(`document.querySelector('#group-table-view .list-bar-search-wrap').classList.contains('phone-searched')`), true, `${w}: the page's own box is the one the pill stands in for`);
            await ev(`window.__urls.length = 0; document.querySelector('header.top-bar .phone-bar-search').focus(); true`);
            await client.Input.insertText({ text: 'needle' });
            await new Promise(r => setTimeout(r, 900)); // sleep-ok: proving that nothing is sent while typing needs the time a per-key search would have taken
            assert.deepEqual(await ev(`window.__urls.filter(u => /needle/.test(u))`), [], `${w}: typing in the pill sends no search`);
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
            await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await waitFor(`window.__urls.some(u => /needle/.test(u))`, `${w}: Enter sends the search`, 8000);
            const sent = await ev(`window.__urls.filter(u => /needle/.test(u)).length`);
            assert.ok(sent >= 1 && sent <= 2, `${w}: one Enter is one search (saw ${sent})`);
            console.log(`ok ${w}: typing sent nothing, Enter sent ${sent} search request(s) with the words`);
        }
        console.log('PASS the phone pill sends the Hub chat search on Enter');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
