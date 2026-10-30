// After a reload an agent's chat opens on its latest messages and the older ones fill in from the top as the reader scrolls up (#10050, the Desktop tester: the top of the chat changed with no word about it). While an older page is being
// fetched the button at the top says "Loading earlier messages..." (and is busy), has its own words back when the page is in, and the reader's place in the chat does not move when the older messages are put above it.
// Drives Chrome over CDP through agent_view_harness.js; /chat is answered by the test, the older page held open until the test lets it go. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const mk = (from, n) => Array.from({ length: n }, (_, i) => (from + i) % 2 === 0 ? { type: 'user', content: `Question number ${from + i}` } : { type: 'assistant', text: `Answer number ${from + i}` });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 700, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => {
            const st = window.__coralStatic || '/static/';
            const T = window.T = { state: (await import(st + 'state.js')).state, chat: await import(st + 'live_chat.js') };
            Object.defineProperty(document, 'hidden', { get: () => false });
            let c = document.getElementById('live-history-messages');
            if (!c) { c = document.createElement('div'); c.id = 'live-history-messages'; c.style.cssText = 'height:400px;overflow:auto'; document.body.appendChild(c); }
            window.__held = null; window.__older = ${JSON.stringify(mk(0, 20))}; window.__latest = ${JSON.stringify(mk(20, 20))};
            const real = window.fetch;
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href);
                if (/\\/api\\/sessions\\/live\\/[^/]+\\/chat$/.test(p.pathname)) {
                    const json = b => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
                    if (p.searchParams.get('before')) return new Promise(res => { window.__held = () => res(json({ messages: window.__older, total: 40, start: 0, has_more: false })); });
                    return Promise.resolve(json({ messages: window.__latest, total: 40, start: 20, has_more: true })); }
                return real(u, o); };
            T.state.currentSession = { name: 'agent-x', type: 'live', session_id: 'sess-x', agent_type: 'claude', working_directory: '/work/x' };
            T.state.autoScroll = true; T.chat.clearKeptChatPages(); T.chat.resetLiveHistory();
            return true; })()`);
        await ev(`window.T.chat.refreshLiveHistory(); true`);
        await waitFor(`document.querySelectorAll('#live-history-messages .chat-bubble').length >= 10 && !!document.querySelector('#live-history-messages > .load-more-btn')`, 'the latest page and the button at the top', { timeout: 8000 });
        assert.equal(await ev(`document.querySelector('#live-history-messages > .load-more-btn').textContent`), 'Load older messages', 'the button has its words while nothing loads');
        // the reader is at the top: the older page is asked for and held open
        await ev(`(() => { const c = document.getElementById('live-history-messages'); c.scrollTop = 0; c.dispatchEvent(new Event('scroll')); window.T.chat.loadMoreHistory(); return true; })()`);
        await waitFor(`!!window.__held`, 'the older page asked for', { timeout: 6000 });
        const loading = await ev(`(() => { const b = document.querySelector('#live-history-messages > .load-more-btn'); return b && { text: b.textContent, busy: b.getAttribute('aria-busy') }; })()`);
        assert.deepEqual(loading, { text: 'Loading earlier messages\u2026', busy: 'true' }, 'while the older page is on its way the button says so: ' + JSON.stringify(loading));
        // the reader's place is kept when the older messages arrive above it
        await ev(`window.__held(); true`);
        await waitFor(`document.querySelectorAll('#live-history-messages .chat-bubble').length >= 30`, 'the older messages above', { timeout: 6000 });
        const placed = await ev(`(() => { const c = document.getElementById('live-history-messages'); const b = [...c.querySelectorAll('.chat-bubble')].find(x => x.textContent.includes('Question number 20')) || [...c.querySelectorAll('.chat-bubble')].find(x => x.textContent.includes('Answer number 21')); return b ? Math.round(b.getBoundingClientRect().top - c.getBoundingClientRect().top) : null; })()`);
        assert.ok(placed !== null && placed >= -2 && placed <= 120, `the message the reader was at is still in view after the older ones arrive: ${placed}`);
        assert.equal(await ev(`document.querySelector('#live-history-messages > .load-more-btn')`), null, 'no older messages left: the button is gone');
        console.log('PASS the button at the top says Loading earlier messages while an older page loads, and the reader keeps their place');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
