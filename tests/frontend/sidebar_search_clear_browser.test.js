// The sidebar's agent search says what hides the list, and clears in one click (#10357 point 2, #10263 second commit, the Desktop recheck: words left in the sidebar search after leaving the Inbox
// made the Agents list read "No agents match. Clear the filters to see them all." with nothing to clear in sight): the box has a visible clear (x) while it holds words; a list with no match says
// "No agents match <words>." with a "Clear search" button, which empties the box and brings the agents back.
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
        await ev(`window.__m.add('qa-bot', 'A', 3, { sleeping: false }); true`);
        await ev(`(async () => { const ws = await import((window.__coralStatic || '/static/') + 'websocket.js'); const render = await import((window.__coralStatic || '/static/') + 'render.js'); const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); if (state.coralWs) { state.coralWs.onclose = null; state.coralWs.onmessage = null; try { state.coralWs.close(); } catch {} } ws.handleCoralMessage({ type: 'coral_update', servers: [], sessions: Object.values(window.__m.agents).map(a => window.__m.entry(a)) }); render.flushLiveSessionsRender(); render.renderLiveSessions(state.liveSessions); return true; })()`);
        await waitFor(`document.querySelectorAll('#live-sessions-list .session-group-item').length > 0`, 'the agents', 8000);
        const rows = () => ev(`document.querySelectorAll('#live-sessions-list .session-group-item').length`);
        const clear = () => ev(`(() => { const c = document.getElementById('agent-search-clear'); return c ? { shown: !c.hidden && c.getClientRects().length > 0, label: c.getAttribute('aria-label') } : null; })()`);
        const empty = () => ev(`(() => { const e = document.querySelector('#live-sessions-list .empty-state'); return e ? { text: e.textContent.replace(/\\s+/g, ' ').trim(), button: !!e.querySelector('button') } : null; })()`);
        const type = v => ev(`(() => { const i = document.getElementById('agent-search-input'); i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        const all = await rows();
        assert.ok(all > 0, 'agents to search');
        const c0 = await clear(); assert.ok(!(c0 && c0.shown), 'nothing typed: no clear button');
        await type('PLUM-4471'); await settle(300);
        const c = await clear();
        assert.ok(c && c.shown && /clear/i.test(c.label || ''), 'words in the box: a visible, named clear: ' + JSON.stringify(c));
        const e = await empty();
        assert.ok(e && /^No agents match plum-4471\. Clear search$/i.test(e.text) && e.button, 'the empty list names the words and offers Clear search: ' + JSON.stringify(e));
        await ev(`[...document.querySelectorAll('#live-sessions-list .empty-state button')].find(b => /Clear search/.test(b.textContent)).click(); true`); await settle(300);
        assert.equal(await ev(`document.getElementById('agent-search-input').value`), '', 'Clear search empties the box');
        assert.equal(await rows(), all, 'and the agents are back');
        await type('a'); await settle(200);
        await ev(`document.getElementById('agent-search-clear').click(); true`); await settle(300);
        assert.equal(await ev(`document.getElementById('agent-search-input').value`), '', 'the x empties the box');
        const c1 = await clear(); assert.ok(!(c1 && c1.shown), 'and goes');
        assert.equal(await rows(), all, 'the agents are back');
        console.log('PASS the sidebar search clears from the box and from the empty list');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
