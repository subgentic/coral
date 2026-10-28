// A local Coral has no Chats list of its own (its chats are the Inbox's folders), so it reads the chat list only when an entry of it is wanted: an opened chat, the Resume dialog (#8195).
// The hub's Chats tab still reads it with the page, which history_filters.startHistoryList keeps. A recorder is installed before any page script runs; the isolated server has no chat, so
// the opened chat is a 404, which is all the order needs: the list is asked once, before the chat's own page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const REC = `(() => { const real = window.fetch.bind(window); window.__asked = []; window.fetch = (input, init) => { try { const u = new URL(typeof input === 'string' ? input : input.url, location.origin); window.__asked.push(u.pathname); } catch {} return real(input, init); }; })()`;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const asked = () => ev(`window.__asked.slice()`);
    const lists = a => a.filter(p => p === '/api/sessions/history').length;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: REC });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings', 'history')`);
        await new Promise(r => setTimeout(r, 1500)); // sleep-ok: proves a negative, the list is not asked for after the page is up
        let a = await asked();
        assert.equal(lists(a), 0, 'a local Coral does not read the chat list at start: ' + JSON.stringify(a.filter(p => /history/.test(p))));
        console.log('PASS no chat list read at start');
        await ev(`Promise.resolve(window.selectHistorySession('lazy-chat-1')).then(() => true)`);
        a = await asked();
        assert.equal(lists(a), 1, 'opening a chat reads the list once: ' + JSON.stringify(a.filter(p => /history/.test(p))));
        const iList = a.indexOf('/api/sessions/history'), iChat = a.findIndex(p => p === '/api/sessions/history/lazy-chat-1');
        assert.ok(iChat > iList && iList >= 0, 'the list is read before the chat\'s own page: ' + JSON.stringify(a.filter(p => /history/.test(p))));
        await ev(`Promise.resolve(window.selectHistorySession('lazy-chat-2')).then(() => true)`);
        a = await asked();
        assert.equal(lists(a), 1, 'a second chat does not read it again');
        console.log('PASS the list is read once, when a chat is opened, before its page');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
