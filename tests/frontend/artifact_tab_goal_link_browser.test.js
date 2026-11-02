// #12025 (the Operator): a file opened from the Artifacts folder (its sheet's Open) shows the same "Goal: <title>" link back to its goal in the opened view; a file with no goal shows none. Stubbed GET /api/team-artifacts. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const art = (id, name, extra) => Object.assign({ id: id.repeat(64), name, media_type: 'text/plain', size: 30, created_at: '2026-10-26T10:00:00Z', source: 'task', uri: 'coral://artifacts/' + id.repeat(64), available: true, inline: false, reference_count: 1, board_id: 'alpha', team: 'alpha' }, extra);
const ITEMS = [art('a', 'with-goal.md', { task_id: 7, task_title: 'A task', goal_id: 3, goal_title: 'Ship the beta' }), art('b', 'no-goal.md', {})];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.href);
                    if (url.pathname === '/api/team-artifacts') return json({ artifacts: ${JSON.stringify(ITEMS)}, limit: 100, offset: 0, has_more: false, truncated: false, total: 2, all: 2, teams: [{ board_id: 'alpha', team: 'alpha', all: 2 }] });
                    if (url.pathname === '/api/system/artifact-store/kept') return json({ kept: [] });
                    if (/^\\/api\\/artifacts\\/[0-9a-f]{64}\\/content$/.test(url.pathname)) return Promise.resolve(new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
                    return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, at + 'the folders', 10000);
            if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); s.value = 'artifacts'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            else await ev(`document.querySelector('.view-list-item[data-key="artifacts"]').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr .dt-primary').length >= 2`, at + 'the rows', 10000);
            for (const [name, goal] of [['with-goal.md', 'Ship the beta'], ['no-goal.md', '']]) {
                await ev(`[...document.querySelectorAll('#group-table-view tbody tr .dt-primary')].find(e => e.textContent.includes(${JSON.stringify(name)})).click(); true`);
                await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Open' && b.getClientRects().length)`, at + name + ' sheet has Open', 8000);
                await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Open' && b.getClientRects().length).click(); true`);
                await waitFor(`!!document.querySelector('.artifact-viewer:not([hidden])') && document.querySelector('.artifact-viewer-title').textContent.includes(${JSON.stringify(name)})`, at + name + ' viewer', 8000);
                const line = await ev(`(() => { const b = document.querySelector('.artifact-viewer-goal'); return b && !b.hidden ? { text: b.textContent.trim(), link: !!b.querySelector('button, a') } : null; })()`);
                if (goal) assert.ok(line && line.link && line.text === 'Goal: ' + goal, at + 'the goal line: ' + JSON.stringify(line));
                else assert.equal(line, null, at + 'no goal line: ' + JSON.stringify(line));
                await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
                await waitFor(`!document.querySelector('.artifact-viewer:not([hidden])')`, at + 'viewer closes', 5000);
            }
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS a file opened from the Artifacts folder links back to its goal; none without one');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
