// #10703 (operator, follow-up to #10685): "Open full board view" in an agent's dock (its Board tab) opens the team's page; that page has "Back to <agent>" that returns to the same agent with its Board tab, at 1280 and 390.
// A real board with a message; a mock agent on it (agent_view_harness).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const B = 'full-view-back-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator' })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'Boss', content: 'A message on the board.' })).status, 200);
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.__m.add('fv-agent', 'B', 1, { sleeping: false, board_project: ${JSON.stringify(B)} }); true`);
            await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'fv-agent')`, at + 'the agent on the board', 8000);
            await ev(`window.selectLiveSession('fv-agent', 'claude', 'fv-agent-id', 'local'); true`);
            await ev(`(() => { const d = document.getElementById('agentic-state'); if (d.getBoundingClientRect().width < 50 || d.classList.contains('collapsed')) { const b = document.getElementById('panel-toggle-btn') || document.getElementById('popout-panel-toggle-btn'); if (b) b.click(); } const t = document.getElementById('agentic-tab-board'); if (t) t.click(); return true; })()`);
            await waitFor(`!!document.querySelector('#agentic-panel-board .board-chat-title')`, at + 'the dock board title', 15000);
            await ev(`document.querySelector('#agentic-panel-board .board-chat-title').click(); true`);
            await waitFor(`document.getElementById('team-page-view').getClientRects().length > 0`, at + 'the team page opens', 10000);
            const back = await ev(`(() => { const b = document.getElementById('team-page-back-agent'); return { shown: !b.hidden && b.getClientRects().length > 0, text: b.textContent, h: b.getBoundingClientRect().height }; })()`);
            assert.ok(back.shown && /Back to fv-agent/.test(back.text), at + 'the page has Back to the agent: ' + JSON.stringify(back));
            assert.ok(!mobile || back.h >= 32, at + 'it is a hit target: ' + back.h);
            await ev(`document.getElementById('team-page-back-agent').click(); true`);
            await waitFor(`document.getElementById('team-page-view').getClientRects().length === 0 && window.__qaState.currentSession && window.__qaState.currentSession.name === 'fv-agent'`, at + 'back on the agent', 10000);
            await waitFor(`document.getElementById('agentic-tab-board').classList.contains('active') && !!document.querySelector('#agentic-panel-board .board-chat-title') && document.querySelector('#agentic-panel-board').getClientRects().length > 0`, at + 'the agent\'s Board tab is showing', 10000);
        }
        console.log('\nPASS Back to the agent from the full board view');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
