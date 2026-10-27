// One line a row (Goal #79, #8960; QA Reviewer 2's #8935 audit items 1, 5, 6): the Inbox Goals, the team Goals, the Inbox Needs you and the team Agents tables keep every row on one line at 1280 and at 390: the
// goal's outcome and the agent's ask are the row's tooltip or its preview, not a second line, and a narrow list drops columns (dropAt) instead of folding. Each row is at most one 48 px line.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const GOALS = [
    { id: 1, board_id: 'team-a', title: 'Ship the importer with a title long enough to need room', outcome: 'Importer is live in production for every customer and the old path is removed', state: 'active', driver: 'Orchestrator', updated_at: '2026-10-20T10:00:00Z', rollup: { done: 2, active: 1, blocked: 0, queued: 1 } },
    { id: 2, board_id: 'team-a', title: 'Cut the cold start', outcome: 'Start under 2 s on a cold machine', state: 'blocked', driver: 'Backend Dev', updated_at: '2026-10-22T10:00:00Z', rollup: { done: 0, active: 0, blocked: 2, queued: 0 } },
    { id: 3, board_id: 'team-b', title: 'Plan the migration', outcome: 'A plan reviewed', state: 'proposed', driver: 'Orchestrator', updated_at: '2026-10-24T10:00:00Z', rollup: { done: 0, active: 0, blocked: 0, queued: 3 } },
];
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const shot = require('./helpers/scene_shots')(Page, 'one-line-rows');
    const B = 'rw-' + Date.now().toString(36);
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const heights = sel => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(r => r.querySelector('td') && r.getClientRects().length).map(r => Math.round(r.getBoundingClientRect().height))`);

    const one = async (label, what, sel, min, max = 48) => { const h = await heights(sel); assert.ok(h.length >= min, `${label}: ${what} has its rows (${h.length})`); assert.ok(h.every(x => x <= max), `${label}: every ${what} row is ${max === 48 ? 'one line' : 'at most the name and one more line'} (heights ${JSON.stringify(h)})`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'settings')`);
            if (label === '1280') { await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator who coordinates the whole team', session_name: 'o-s' }); await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'dev', job_title: 'Developer', session_name: 'd-s' });
                for (const g of [['Ship the thing with a long title', 'A long outcome sentence that wraps over several lines at large text'], ['Second goal', 'Short']]) { const r = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: g[0], outcome: g[1], done_when: 'done' }); await api('PATCH', `/api/board/${B}/goals/${r.body.id}`, { subscriber_id: 'Operator', state: 'active' }); } }
            // Needs you
            await ev(`(() => { window.__m.add('Frontend Dev', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'fe-id' }); window.__m.add('Backend Dev', 'B', 4, { sleeping: false, board_project: 'team-a', session_id: 'be-id' }); return true; })()`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length >= 2`, 'agents', 8000);
            await ev(`(async () => { const ago = m => new Date(Date.now() - m * 60000).toISOString(); const W = { 'fe-id': ['permission', ago(3)], 'be-id': ['question', ago(30)] }; window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, waiting_for_input: true, waiting_kind: (W[s.session_id] || ['', ''])[0], waiting_since: (W[s.session_id] || ['', ''])[1], waiting_summary: 'Wants to run: npm test -- --coverage --watch=false in the frontend folder and then push the result to the shared branch' })); (await import((window.__coralStatic || '/static/') + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`); await settle(1200); if (mobile) await ev(`(() => { const b = document.querySelector('.view-list-item[data-key="needs"]'); if (b) b.click(); return true; })()`); await settle(1200);
            await one(label, 'Needs you', '#group-table-view tr', 2, 64); // the one exception (UI/UX): the ask is a second line under the agent's name, 12/400 secondary, cut with an ellipsis; every other column stays one line
            const ask = await ev(`(() => { const s = [...document.querySelectorAll('#group-table-view td .dt-subtitle')].filter(e => e.getClientRects().length); const c = s[0] && getComputedStyle(s[0]); return { n: s.length, text: s[0] ? s[0].textContent : '', title: s[0] ? s[0].title : '', size: c && c.fontSize, weight: c && c.fontWeight, cut: c && c.textOverflow, nowrap: c && c.whiteSpace }; })()`);
            assert.ok(ask.n >= 2 && /^Wants to run/.test(ask.text), `${label}: each Needs you agent shows its ask under the name: ` + JSON.stringify(ask));
            assert.ok(ask.title && ask.title === ask.text, `${label}: the whole ask is the line's title, so a cut one can be read (#9495): ` + JSON.stringify([ask.title, ask.text]));
            assert.deepEqual([ask.size, ask.weight, ask.cut, ask.nowrap], ['12px', '400', 'ellipsis', 'nowrap'], `${label}: the ask is 12/400, cut with an ellipsis, on one line`); await shot(`${label}-needs`);
            // Goals folder
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => /\\/api\\/goals(\\?|$)/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({ goals: ${JSON.stringify(GOALS)} }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : R(u, o); return true; })()`);
            if (mobile) await ev(`(() => { const b = document.querySelector('.view-list-item[data-key="goals"]'); if (b) b.click(); return true; })()`);
            else await ev(`document.querySelector('.view-list-item[data-key="goals"]').click(); true`);
            await settle(1800); await one(label, 'Inbox Goals', '#group-table-view tr', 2); await shot(`${label}-goals`);
            // team goals + agents
            for (const tab of ['goals', 'agents']) {
                await Page.navigate({ url: BASE + `/team/${B}/${tab}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await settle(2000);
                await one(label, 'team ' + tab, '.team-panel tr', 2); await shot(`${label}-team-${tab}`);
            }
        }
        console.log('PASS one line rows: the Inbox Goals and Needs you and the team Goals and Agents keep every row on one line at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
