// The sidebar's agent search says what it searches and offers every chat (#10050, the Desktop tester: a Claude Desktop user looks for a past conversation in the sidebar's one search box): the box reads "Search agents";
// once something is typed a quiet line under it offers "Search all chats for <the words>". With nothing typed the line is not there. (Pressing it opens All chats with the words searched: sidebar_search_all_chats_carries_browser.)
// 1280 px, isolated dev server, the harness's stand-in agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const box = () => ev(`(() => { const i = document.getElementById('agent-search-input'), b = document.getElementById('agent-search-all-chats'); return { placeholder: i && i.placeholder, label: i && i.getAttribute('aria-label'), line: b && !b.hidden && b.getClientRects().length > 0 ? b.textContent : null, role: b && b.tagName }; })()`);
        let s = await box();
        assert.equal(s.placeholder, 'Search agents', 'the box says what it searches');
        assert.equal(s.line, null, 'nothing typed: no offer');
        await ev(`(() => { const i = document.getElementById('agent-search-input'); i.focus(); i.value = 'build'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await settle(200);
        s = await box();
        assert.equal(s.line, 'Search all chats for \u201cbuild\u201d', 'the offer names the words: ' + JSON.stringify(s));
        assert.equal(s.role, 'BUTTON');
        await ev(`(() => { const i = document.getElementById('agent-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await settle(200);
        assert.equal((await box()).line, null, 'cleared: the offer goes');
        await ev(`(() => { const i = document.getElementById('agent-search-input'); i.value = 'build failed'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await settle(200);
        // pressing it opens the Inbox's All chats with the words searched: sidebar_search_all_chats_carries_browser
        console.log('PASS the sidebar search offers a search of every chat');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
