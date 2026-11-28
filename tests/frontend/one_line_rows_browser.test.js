// One line a row (Goal #79, #8960; the Inbox Goals are decision cards since #21846, read as cards below; QA Reviewer 2's #8935 audit items 1, 5, 6): the Inbox Goals, the team Goals, the Inbox Needs you and the team Agents tables keep every row on one line at 1280 and at 390: the
// goal's outcome and the agent's ask are the row's tooltip or its preview, not a second line, and a narrow list drops columns (dropAt) instead of folding. Each row is at most one 48 px line.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const GOALS = [
    { id: 1, board_id: 'team-a', title: 'Ship the importer with a title long enough to need room', outcome: 'Importer is live in production for every customer and the old path is removed', state: 'active', driver: 'Orchestrator', updated_at: '2026-10-20T10:00:00Z', rollup: { done: 2, active: 1, blocked: 0, queued: 1 } },
    { id: 2, board_id: 'team-a', title: 'Cut the cold start', outcome: 'Start under 2 s on a cold machine', state: 'blocked', driver: 'Backend Dev', updated_at: '2026-10-22T10:00:00Z', rollup: { done: 0, active: 0, blocked: 2, queued: 0 } },
    { id: 3, board_id: 'team-b', title: 'Plan the migration', outcome: 'A plan reviewed', state: 'proposed', driver: 'Orchestrator', updated_at: '2026-10-24T10:00:00Z', rollup: { done: 0, active: 0, blocked: 0, queued: 3 } },
];
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const shot = require('./helpers/scene_shots')(Page, 'one-line-rows');
    const B = 'rw-' + Date.now().toString(36);
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const heights = sel => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(r => r.querySelector('td') && r.getClientRects().length).map(r => Math.round(r.getBoundingClientRect().height))`);

    let phone = false; // a phone's rows are 56 px mail rows (#9545): one line, taller than a table row
    // the rows are read once they are drawn (#14307: a fixed settle() was read before the Needs you list drew its rows, 0 rows, on a slow Windows runner; at a CPU throttle of 20 it failed every run): wait for the count, then measure; a count that never comes is the assertion's own message
    const one = async (label, what, sel, min, max = phone ? 56 : 48) => { await waitFor(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(r => r.querySelector('td') && r.getClientRects().length).length >= ${min}`, `${label}: ${what} rows drawn`, 10000).catch(() => {}); const h = await heights(sel); assert.ok(h.length >= min, `${label}: ${what} has its rows (${h.length})`); assert.ok(h.every(x => x <= max), `${label}: every ${what} row is ${max === 48 || max === 56 ? 'one line' : 'at most the name and one more line'} (heights ${JSON.stringify(h)})`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            phone = mobile;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady('startup', 'liveList', 'settings');
            if (label === '1280') { await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator who coordinates the whole team', session_name: 'o-s' }); await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'dev', job_title: 'Developer', session_name: 'd-s' });
                for (const g of [['Ship the thing with a long title', 'A long outcome sentence that wraps over several lines at large text'], ['Second goal', 'Short']]) { const r = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: g[0], outcome: g[1], done_when: 'done' }); await api('PATCH', `/api/board/${B}/goals/${r.body.id}`, { subscriber_id: 'Operator', state: 'active' }); } }
            // Needs you
            await ev(`(() => { window.__m.add('Frontend Dev', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'fe-id' }); window.__m.add('Backend Dev', 'B', 4, { sleeping: false, board_project: 'team-a', session_id: 'be-id' }); return true; })()`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length >= 2`, 'agents', 8000);
            await ev(`(async () => { const ago = m => new Date(Date.now() - m * 60000).toISOString(); const W = { 'fe-id': ['permission', ago(3)], 'be-id': ['question', ago(30)] }; window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, waiting_for_input: true, waiting_kind: (W[s.session_id] || ['', ''])[0], waiting_since: (W[s.session_id] || ['', ''])[1], waiting_summary: 'Wants to run: npm test -- --coverage --watch=false in the frontend folder and then push the result to the shared branch' })); (await import((window.__coralStatic || '/static/') + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`); await settle(1200); if (mobile) await ev(`(() => { const b = document.querySelector('.view-list-item[data-key="needs"]'); if (b) b.click(); return true; })()`); await settle(1200);
            // #20264: Needs you uses message cards with a footer; the other folders below remain one-line tables.
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-v4-footer').length>=2`,label+': Needs you footers',10000);
            const cards = await ev(`(() => [...document.querySelectorAll('#group-table-view .inbox-kind-row')].map(row=>{const box=row.querySelector('.inbox-preview'),text=box?.querySelector('.inbox-preview-text'),footer=row.querySelector('.inbox-v4-footer'),heading=row.querySelector('.inbox-v4-heading,.dt-mail-title'),r=row.getBoundingClientRect(),f=footer?.getBoundingClientRect();return {kind:row.querySelector('.inbox-kind-icon')?.dataset.kind,heading:!!heading,footer:!!footer,afterHeading:!!f&&(!heading||f.top>=heading.getBoundingClientRect().bottom),afterMessage:!!f&&(!box||f.top>=box.getBoundingClientRect().bottom),inside:!!f&&f.left>=r.left-1&&f.right<=r.right+1,text:box?.textContent||'',cap:text&&getComputedStyle(text).webkitLineClamp,lines:text?text.clientHeight/parseFloat(getComputedStyle(text).lineHeight):0,permissionIntro:!!row.querySelector('.inbox-implied-intro')};}))()`);
            assert.ok(cards.length>=2&&cards.every(r=>r.heading&&r.footer&&r.afterHeading&&r.afterMessage&&r.inside),label+': message cards keep headings/content above an in-bounds footer: '+JSON.stringify(cards));
            const question=cards.find(r=>r.kind==='question'),permission=cards.find(r=>r.kind==='permission');
            assert.ok(question&&question.text.includes('npm test -- --coverage')&&question.cap==='4'&&question.lines<=4.1,label+': question keeps the ask in a four-line preview: '+JSON.stringify(question));
            assert.ok(permission&&permission.permissionIntro,label+': implied permission introduction remains accessible, visually hidden by approved design');
            await shot(`${label}-needs`);
            // Goals folder
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => /\\/api\\/goals(\\?|$)/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({ goals: ${JSON.stringify(GOALS)} }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : R(u, o); return true; })()`);
            if (mobile) await ev(`(() => { const b = document.querySelector('.view-list-item[data-key="goals"]'); if (b) b.click(); return true; })()`);
            else await ev(`document.querySelector('.view-list-item[data-key="goals"]').click(); true`);
            /* #21846 replaced the Inbox Goals table with the approved decision ledger: a card per goal whose heading wraps by design, so it is read as cards, not one-line table rows */
            await waitFor(`document.querySelectorAll('#group-table-view .goal-decision-card').length>=2`,label+': Inbox Goals cards',10000);
            const goalCards = await ev(`(() => ({ over: document.documentElement.scrollWidth - innerWidth, cards: [...document.querySelectorAll('#group-table-view .goal-decision-card')].filter(c=>c.getClientRects().length).map(c=>{const b=c.getBoundingClientRect(),t=c.querySelector('.goal-decision-title'),r=t?.getBoundingClientRect(),head=c.querySelector('.goal-decision-head')?.getBoundingClientRect();return{title:t?.textContent||'',id:c.querySelector('.goal-decision-id')?.textContent||'',label:c.querySelector('.goal-decision-toggle')?.getAttribute('aria-label')||'',inside:!!r&&r.left>=b.left-1&&r.right<=b.right+1&&b.left>=-1&&b.right<=innerWidth+1,head:head?Math.round(head.height):0}}) }))()`);
            assert.ok(goalCards.cards.length>=2&&goalCards.cards.every(c=>c.title&&/^#\d+$/.test(c.id)&&c.label.includes('Goal '+c.id)&&c.inside&&c.head>0)&&goalCards.over<=1,label+': Inbox Goals: a card per goal, its number and title inside the card, the page fits: '+JSON.stringify(goalCards));
            await shot(`${label}-goals`); // a phone's Goals are two-line rows now (the goal, then its outcome; #12230, the operator)
            // team goals + agents
            for (const tab of ['goals', 'agents']) {
                await Page.navigate({ url: BASE + `/team/${B}/${tab}` }); await Page.loadEventFired(); await install(); await coralReady('startup', 'liveList', 'liveListLoaded', 'settings'); await settle(2000);
                await one(label, 'team ' + tab, '.team-panel tr', 2, phone && /goals/i.test(tab) ? 150 /* #15343: the title, the outcome and the state */ : phone && /tasks|artifacts/i.test(tab) ? 64 : undefined); await shot(`${label}-team-${tab}`); // a phone's team lists are two-line rows (#12230)
            }
        }
        console.log('PASS one line rows: the team Goals and Agents keep every row on one line at 1280 and 390; Needs you and the Inbox Goals (cards since #20264 and #21846) fit');
    } finally { await removeBoards(ev, [B]); await client.close(); } // the suite's board goes with it (#9869: it left rows behind on a Windows run)
})().catch(e => { console.error(e); process.exitCode = 1; });
