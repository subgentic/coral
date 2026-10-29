// A chat's way back is pressed before the Inbox has loaded (#8817, the product race #8809 found): a chat opened by a link or a reload (/chats/<id>) says "<- All chats" on a local Coral, and the press asks the
// sidebar group source of the Inbox for that folder, but the source is registered by inbox_sidebar.js, a lazy module (#8670) that the chat's own page loads only a moment later. Before: the press found no
// source and did nothing, and the person had to press again. Now the press waits for the module and then opens the folder.
// The module's request is held (a Fetch pause, cache off), the chat is opened by its own address, the real "<- All chats" button is pressed while the module is still out, and then the module is released:
// the folder must show. The history list and the chat are answered at the page's fetch. Drives Chrome over CDP through agent_view_harness.js at 1280 (a phone's way back loads the module itself).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const STUB = `(() => {
    const real = window.fetch; const json = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const rows = [{ session_id: 'aaaaaa1', title: 'The newest chat', source_type: 'claude', display_name: 'Ada', last_timestamp: new Date().toISOString() }];
    const chat = sid => json({ session_id: sid, agent_type: 'claude', messages: [{ type: 'user', content: 'Hello' }, { type: 'assistant', text: 'Hi' }], total: 2, start: 0 });
    window.fetch = (u, o) => { const url = new URL(String(u), location.href), p = url.pathname;
        if (p === '/api/sessions/history') return json({ sessions: rows, total: rows.length, page: 1, page_size: 50 });
        if (/^\\/api\\/sessions\\/history\\/[a-z0-9]+$/.test(p)) return chat(p.split('/').pop());
        if (/^\\/api\\/sessions\\/history\\/[a-z0-9]+\\//.test(p)) return json([]);
        return real(u, o); };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const held = [];
    let hold = false;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await client.Network.enable(); await client.Network.setCacheDisabled({ cacheDisabled: true }); // each load asks for the module again, so its request is made and held
        await client.Fetch.enable({ patterns: [{ urlPattern: '*inbox_sidebar.js*' }] });
        safePaused(client, ({ requestId }) => {
            if (hold) { held.push(requestId); return undefined; }
            return client.Fetch.continueRequest({ requestId });
        });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false]]) { // a phone's way back is the Chats tab (history-list: switchNavTab loads the module itself), so only the desktop button has the race
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            held.length = 0; hold = true;
            await Page.navigate({ url: BASE + '/chats/aaaaaa1' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await waitFor(`document.getElementById('history-session-view') && document.getElementById('history-session-view').checkVisibility() && document.getElementById('history-back').checkVisibility()`, `${label}: the chat opens by its address, with its way back`, 15000);
            assert.equal(await ev(`document.getElementById('history-back').textContent`), '\u2190 All chats', `${label}: the way back names the Inbox folder`);
            const deadline = Date.now() + 4000;
            while (!held.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 100)); // sleep-ok: waiting for the Inbox module's request to be made and held
            assert.ok(held.length > 0, `${label}: the Inbox module is still out when the way back is pressed (the chat's page asks for it)`);
            await ev(`document.getElementById('history-back').click(); true`); // the real button, while the module is out
            hold = false;
            for (const requestId of held.splice(0)) await client.Fetch.continueRequest({ requestId });
            await waitFor(`(document.getElementById('group-table-view') || {}).dataset && document.getElementById('group-table-view').dataset.group === 'hub-inbox:chats' && document.getElementById('group-table-view').checkVisibility()`, `${label}: the folder shows once the module has loaded (it did nothing before)`, 10000);
            console.log(`PASS ${label}: an early way back from a chat opened by its address waits for the Inbox module and opens the folder`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
