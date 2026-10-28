// A message the person sent, in a chat's history on a phone (#10738, Mobile pass 39): "Edit & Resubmit" sat to the left of the bubble, partly off the screen (its left edge was at -17 px at 390) and crowding the bubble, and the
// time touched the bubble's corner. Now the button opens inside the bubble's foot when the bubble is tapped or has the keyboard (it is on the screen, over nothing) and the time has a gap below the bubble. At 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`(() => { const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
            const row = { session_id: 'chat-e', type: 'agent', title: 'Canned chat', summary: 'a chat', agent_type: 'claude', source_type: 'claude', last_timestamp: new Date().toISOString(), duration_sec: 60, starred: false, archived: false, active: false, tags: [], server: 'local' };
            const t = new Date().toISOString();
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
                if (url.pathname === '/api/sessions/history/counts') return json({ all: 1, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: {}, tags: [] });
                if (url.pathname === '/api/sessions/history') return json({ sessions: [row], total: 1, page: 1, page_size: 50 });
                if (/\\/api\\/sessions\\/history\\/chat-e/.test(url.pathname)) return json({ messages: [{ type: 'user', content: 'Say something canned to me please', timestamp: t, key: 'k1' }, { type: 'assistant', text: 'This reply is canned. You said hello.', timestamp: t, key: 'k2' }, { type: 'user', content: 'Thanks', timestamp: t, key: 'k3' }], total: 3, start: 0, has_more: false, session_id: 'chat-e' });
                return R(u, o); }; window.__row = row; return true; })()`);
        await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); state.historySessionsList = [{ ...window.__row }]; return true; })()`);
        await ev(`Promise.resolve(window.selectHistorySession('chat-e')).then(() => true)`);
        await waitFor(`document.querySelectorAll('.chat-bubble.human').length >= 2`, 'the bubbles', 10000);
        for (const i of [0, 1]) {
            await ev(`document.querySelectorAll('.chat-bubble.human')[${i}].querySelector('.edit-btn').focus(); true`); // the keyboard on the button: the bubble shows it, as a tap does
            await waitFor(`getComputedStyle(document.querySelectorAll('.chat-bubble.human')[${i}].querySelector('.edit-btn')).opacity === '1'`, `bubble ${i}: the button fades in`, 3000).catch(() => {});
            const m = await ev(`(() => { const b = document.querySelectorAll('.chat-bubble.human')[${i}], rc = e => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }, e = b.querySelector('.edit-btn'), t = b.querySelector('.message-time'), menu = b.querySelector('.chat-msg-menu-btn');
                return { bubble: rc(b), edit: rc(e), shown: getComputedStyle(e).opacity === '1' && e.getClientRects().length > 0, time: t ? rc(t) : null, menu: menu ? rc(menu) : null, vw: innerWidth }; })()`);
            const hit = (a, c) => a && c && a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b;
            if (!m.shown) problems.push(`bubble ${i}: the button is shown when the bubble has the keyboard`);
            if (m.edit.l < 0 || m.edit.r > m.vw) problems.push(`bubble ${i}: the button is on the screen (it is at ${Math.round(m.edit.l)} to ${Math.round(m.edit.r)} of ${m.vw})`);
            if (hit(m.edit, m.time) || hit(m.edit, m.menu)) problems.push(`bubble ${i}: the button sits on the time or the menu`);
            if (m.time && m.time.t < m.bubble.b + 2) problems.push(`bubble ${i}: the time touches the bubble (it starts ${Math.round(m.time.t - m.bubble.b)} px below it)`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Edit & Resubmit on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS Edit & Resubmit and the time do not crowd the sent bubble');
})().catch(e => { console.error(e); process.exit(1); });
