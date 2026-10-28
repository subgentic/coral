// The team Tasks tab's toolbar keeps its New task button whole at a mouse (#9861, #9856's shot): seven state pills with their counts do not fit beside the search, the Filters icon and New task in a
// 1280 or 1024 px window with the sidebar open, and the button was cut at the pane's right edge. When the pills do not fit they are the compact select; the row never overflows and New task is on screen.
// Real isolated dev server, an API-seeded board (the pattern of team_tasks_one_line_browser).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const board = 'task-tb-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const api = (p, body) => ev(`fetch(${JSON.stringify(p)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
        assert.equal((await api(`/api/board/${board}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator' })).status, 200);
        const goal = await api(`/api/board/${board}/goals`, { title: 'A goal', outcome: 'x', subscriber_id: 'Operator' });
        for (let i = 1; i <= 3; i++) assert.equal((await api(`/api/board/${board}/tasks`, { subscriber_id: 'Boss', assigned_to: 'Boss', goal_id: goal.body.id, title: `Task ${i}` })).status, 201);
        for (const width of [1600, 1280, 1024]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
            await Page.navigate({ url: `${BASE}/team/${board}/tasks` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr').length >= 3`, width + ': the task rows', 15000);
            const bar = await ev(`(() => { const row = document.querySelector('#team-panel-tasks .list-bar-search-row'), btn = row.querySelector('.team-tb-action'), pane = document.getElementById('team-panel-tasks').getBoundingClientRect(), r = btn.getBoundingClientRect();
                const shown = e => !!e && e.getClientRects().length > 0;
                return { btnLeft: Math.round(r.left), btnRight: Math.round(r.right), btnShown: shown(btn), paneRight: Math.round(pane.right), rowOver: row.scrollWidth - row.clientWidth, pills: shown(row.querySelector('.team-tb-pills')), select: shown(row.querySelector('.team-tb-select')), text: btn.textContent.trim() }; })()`);
            assert.ok(bar.btnShown && bar.text === 'New task', width + ': New task is on the toolbar ' + JSON.stringify(bar));
            assert.ok(bar.btnRight <= bar.paneRight, width + ': New task is whole, not cut at the pane\'s right edge ' + JSON.stringify(bar));
            assert.ok(bar.rowOver <= 1, width + ': the toolbar row does not overflow sideways ' + JSON.stringify(bar));
            assert.ok(bar.pills !== bar.select, width + ': the state choice is the pills or the select, not both nor neither ' + JSON.stringify(bar));
            const names = await ev(`(() => { const g = document.querySelector('#team-panel-tasks .team-tb-pills'), s = document.querySelector('#team-panel-tasks .team-tb-select'); return { role: g.getAttribute('role'), label: g.getAttribute('aria-label'), selectLabel: s.getAttribute('aria-label') }; })()`);
            assert.ok(names.role === 'group' && names.label && names.label === names.selectLabel, width + ': the pills are a named group (role group, the same name as the select) for a screen reader ' + JSON.stringify(names));
            console.log(`PASS ${width}px: New task whole (right ${bar.btnRight} of ${bar.paneRight}), ${bar.pills ? 'the pills fit' : 'the select stands in'}`);
        }
    } finally { await removeBoards(ev, [board]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
