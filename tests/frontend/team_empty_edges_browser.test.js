// Every team tab's empty state starts at the page's content edge (#9470, QA Engineer's note on #9455: .team-panel .empty-state zeroes its side padding, so an empty state that was inset by its padding would lose it, and the Board's own
// notice sat 8 px inside the edge by its list's padding). Goals, Tasks, Artifacts, Knowledge and Board on a team with nothing, Agents on a team with no agent; the words' left edge is the page title's, at 1280 and 390, with shots. A real
// board on the isolated dev server (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const B1 = 'tee-' + Date.now().toString(36), B2 = B1 + 'x';
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        assert.ok((await api('POST', `/api/board/${B1}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-s' })).status < 300); // a team with an agent and nothing else
        const g = await api('POST', `/api/board/${B2}/goals`, { subscriber_id: 'Operator', title: 'tmp', outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201); // a team with no agent
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            for (const [B, tab] of [[B1, 'goals'], [B1, 'tasks'], [B1, 'artifacts'], [B1, 'knowledge'], [B1, 'messages'], [B2, 'agents']]) {
                await Page.navigate({ url: BASE + `/team/${B}/${tab}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
                await waitFor(`[...document.querySelectorAll('[role=tabpanel][id^=team-panel-]:not([hidden]) .empty-state, [role=tabpanel][id^=team-panel-]:not([hidden]) .empty-state-line')].some(e => e.getClientRects().length)`, `${at}${tab}: an empty state`, 15000);
                const r = await ev(`(() => { const vis = e => e && e.getClientRects().length; const panel = document.querySelector('[role=tabpanel][id^=team-panel-]:not([hidden])'); const line = [...panel.querySelectorAll('.empty-state-line, .empty-state')].filter(vis).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
                    // the words' left edge: the first text node's range, not the box (an empty state's box may start before its words)
                    const rng = document.createRange(); const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); const n = w.nextNode(); rng.selectNodeContents(n); const t = document.getElementById('team-page-title');
                    return { words: Math.round(rng.getBoundingClientRect().left * 10) / 10, title: Math.round(t.getBoundingClientRect().left * 10) / 10, text: n.textContent.trim().slice(0, 30) }; })()`);
                assert.ok(Math.abs(r.words - r.title) <= 1, `${at}${tab}: "${r.text}" starts at the page's content edge: words ${r.words}, title ${r.title}`);
                await shot(`team-empty-${tab}-${w}`);
            }
        }
        console.log('PASS team empty edges: every team tab\'s empty state starts at the page title\'s left edge');
    } finally { await removeBoards(ev, [B1, B2]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
