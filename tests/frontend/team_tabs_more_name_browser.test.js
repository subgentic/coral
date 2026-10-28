// The team page's tab row on a phone (#10759, Mobile pass 38): the tabs behind More (Knowledge, Board) have no tab in the row, so a team that opens on the Board showed the row with More underlined and nothing named Board.
// More now carries the open tab's name while one of its tabs is open ("Board", "Knowledge") and says "More" otherwise; the row still fits 320 and 390 px with no sideways scroll. A real board over the API.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'tabs-more-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[390, 844], [320, 640]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-s' });
            await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'Boss', content: 'Please check the release notes.' });
            const seen = async tab => {
                await Page.navigate({ url: `${BASE}/team/${B}/${tab}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
                await waitFor(`!!document.getElementById('team-tab-more') && document.getElementById('team-tab-more').getClientRects().length > 0`, `${w}: the tab row on ${tab}`, 15000);
                await waitFor(`document.getElementById('team-tab-${tab}') && document.getElementById('team-tab-${tab}').getAttribute('aria-selected') === 'true'`, `${w}: ${tab} is the open tab`, 15000);
                return ev(`(() => { const m = document.getElementById('team-tab-more'), row = document.getElementById('team-tabs-row'); return { more: (m.querySelector('.team-tab-label') || m).textContent.trim(), current: m.classList.contains('is-current'), label: m.getAttribute('aria-label'), over: row.scrollWidth - row.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
            };
            const board = await seen('messages');
            if (board.more !== 'Board') problems.push(`${w}: with the Board open, More says "${board.more}" (it should say Board)`);
            if (!/Board/.test(board.label || '')) problems.push(`${w}: the button is still named for the Board for a screen reader (${board.label})`);
            if (board.over > 1 || board.page > 1) problems.push(`${w}: the tab row or page scrolls sideways with "${board.more}" in it (${board.over}, ${board.page})`);
            const k = await seen('knowledge');
            if (k.more !== 'Knowledge') problems.push(`${w}: with Knowledge open, More says "${k.more}"`);
            if (k.over > 1 || k.page > 1) problems.push(`${w}: the tab row or page scrolls sideways with "${k.more}" in it (${k.over}, ${k.page})`);
            const g = await seen('goals');
            if (g.more !== 'More' || g.current) problems.push(`${w}: on Goals More says "${g.more}" and is ${g.current ? '' : 'not '}current (it should say More, not current)`);
        }
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the team page tab row on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS More names the open tab behind it');
})().catch(e => { console.error(e); process.exit(1); });
