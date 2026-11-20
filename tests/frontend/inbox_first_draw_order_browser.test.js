// Inbox walk #20009 item 7 (#20017): a fresh load of six questions with mixed times draws them in the sort order at once: newest first on Waiting on you (the Operator's default, #11552), and on Waiting on an agent the longest waiting first (the mock's "Longest waiting first"). Late arrivals keep first-seen order (#12636, needs_order_stable_browser).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    const MINUTES = { Alpha: 40, Bravo: 5, Charlie: 25, Delta: 55, Echo: 12, Foxtrot: 31 }; // mixed, and not in the order they are listed in
    const ask = (id, asker, minutes) => ({ board: 'team-a', kind: 'ask', id, asker, text: 'Q-' + asker + '-end', at: new Date(Date.now() - minutes * 60000).toISOString() });
    const waiting = (id, name, minutes) => ({ kind: 'answered_ask', id, board: 'team-a', agent: { name, role: '', session_id: 'sess-' + name }, since: new Date(Date.now() - minutes * 60000).toISOString(), title: 'W-' + name + '-end', operator_words: 'ok', goal: null, task: null, artifact: null, thread_id: null });
    const order = re => ev(`[...document.querySelectorAll('${T} tbody tr')].map(r => (${re}.exec(r.textContent) || [])[1]).filter(Boolean)`);
    const byTime = dir => Object.entries(MINUTES).sort((a, b) => dir * (a[1] - b[1])).map(e => e[0]); // dir 1: newest (fewest minutes) first
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(INBOX_WORLD);
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); localStorage.removeItem('coral-inbox-needs-tab');
                window.__asks = ${JSON.stringify(Object.entries(MINUTES).map(([n, m], i) => ask(i + 1, n, m)))}; window.__waiting = ${JSON.stringify(Object.entries(MINUTES).map(([n, m], i) => waiting(100 + i, n, m)))};
                (() => { const original = window.fetch; window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })); if (u.pathname === '/api/operator-asks') return json(window.__asks); if (u.pathname === '/api/waiting-on-agent') return json({ items: window.__waiting }); if (u.pathname === '/api/settings' && opts.method === 'PUT') return json({ ok: true }); return original(url, opts); }; return true; })()`);
            await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = []; m.updateInboxTab(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 6`, 'the six questions', 15000);
            await ev(framesJs(10));
            assert.deepEqual(await order(/Q-(\w+)-end/), byTime(1), at + 'a fresh load draws Waiting on you newest first');
            await ev(`document.querySelector('[data-needs-tab="agent"]').click(); true`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 6 && /W-\\w+-end/.test(document.querySelector('${T} tbody').textContent)`, 'the six waiting items', 15000);
            await ev(framesJs(10));
            assert.deepEqual(await order(/W-(\w+)-end/), byTime(-1), at + 'a fresh load draws Waiting on an agent longest waiting first');
        }
    } finally { await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
