// The artifact list's Goal column (#9274, the Operator): the Inbox's Artifacts folder and the team's Artifacts tab (one shared table) show the GOAL of a file's task, one line, cut with an ellipsis, the whole title as
// its tooltip, a link that opens the goal; empty for a file with no task or a task with no goal. The old Task column wrapped a long title into a tall row (9 rem, nowrap off). Stubbed GET /api/team-artifacts; 1280 and 390;
// a long goal title and a long task title must not make a row taller than the others. Drives Chrome over CDP against the isolated dev server. CORAL_SCREENSHOT_DIR=<dir> saves shots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const LONG_GOAL = 'Fast, reliable releases: every tag publishes on the first run, the dry run says go, and the cask points at the release';
const LONG_TASK = 'Goal #84 batch goldens found by QA Engineer on 152b: html_builders_golden, live_list_golden and task_list_golden are red';
const art = (id, name, extra) => Object.assign({ id: id.repeat(64), name, media_type: 'text/markdown', size: 1000, created_at: '2026-10-26T10:00:00Z', source: 'task', uri: 'coral://artifacts/' + id.repeat(64), available: true, inline: false, reference_count: 1, board_id: 'alpha', team: 'alpha' }, extra);
const ITEMS = [
    art('a', 'long-goal-report.md', { task_id: 7, task_title: LONG_TASK, goal_id: 3, goal_title: LONG_GOAL }),
    art('b', 'no-task-notes.md', {}),
    art('c', 'no-goal-task.md', { task_id: 9, task_title: 'A short task' }),
    art('d', 'short-goal.md', { task_id: 8, task_title: 'Another task', goal_id: 4, goal_title: 'Ship the beta' }),
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')); if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`try { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-inbox-') || k.startsWith('coral-saved-filters')) localStorage.removeItem(k); } catch {} true`);
            await ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.href);
                    if (url.pathname === '/api/team-artifacts') return json({ artifacts: ${JSON.stringify(ITEMS)}, limit: 100, offset: 0, has_more: false, truncated: false, total: ${ITEMS.length}, all: ${ITEMS.length}, teams: [{ board_id: 'alpha', team: 'alpha', all: ${ITEMS.length} }] });
                    if (url.pathname === '/api/system/artifact-store/kept') return json({ kept: [] });
                    return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, `${label}: the folders`, 10000);
            if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); s.value = 'artifacts'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            else await ev(`document.querySelector('.view-list-item[data-key="artifacts"]').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= ${ITEMS.length}`, `${label}: the artifact rows`, 10000);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr .dt-primary').length >= ${ITEMS.length}`, `${label}: the rows' names`, 4000);
            const t = await ev(`(() => { const box = document.querySelector('#group-table-view .dt-box'), heads = [...document.querySelectorAll('#group-table-view thead th')].filter(h => h.getClientRects().length).map(h => h.dataset.key || ''),
                rows = [...document.querySelectorAll('#group-table-view tbody tr')].map(r => { const name = r.querySelector('.dt-primary').textContent, g = r.querySelector('[data-goal-link]'); return { name, mail: r.classList.contains('dt-mailed'), h: Math.round(r.getBoundingClientRect().height), goal: g ? { text: g.textContent, title: g.title, aria: g.getAttribute('aria-label'), cut: g.scrollWidth > g.clientWidth + 1, overflow: getComputedStyle(g).textOverflow, ws: getComputedStyle(g).whiteSpace, h: Math.round(g.getBoundingClientRect().height) } : null, cell: ((r.querySelector('td[data-key="goal"]') || {}).textContent || '').trim() }; });
                return { heads, rows, sideways: box.scrollWidth > box.clientWidth + 1 }; })()`);
            const by = n => t.rows.find(r => r.name === n);
            // a phone's Inbox rows are mail rows (56 px, #9545 and #9583): one line each, all the same
            check(`${label}: no row is taller than the others (one line each)`, Math.max(...t.rows.map(r => r.h)) - Math.min(...t.rows.map(r => r.h)) <= 2 && Math.max(...t.rows.map(r => r.h)) <= (t.rows.some(r => r.mail) ? 60 : 46), JSON.stringify(t.rows.map(r => [r.name, r.h])));
            check(`${label}: no sideways scroll`, !t.sideways);
            if (!t.heads.includes('goal')) { check(`${label}: a phone drops the Goal column and keeps the Task column out`, !t.heads.includes('task'), JSON.stringify(t.heads)); await shot(`artifact-goal-column-${label}`); continue; }
            check(`${label}: the column is Goal, not Task`, t.heads.includes('goal') && !t.heads.includes('task'), JSON.stringify(t.heads));
            const lg = by('long-goal-report.md').goal;
            check(`${label}: a long goal is one line with an ellipsis, its whole title the tooltip and the accessible name`, lg && lg.cut && lg.overflow === 'ellipsis' && lg.ws === 'nowrap' && lg.title === LONG_GOAL && lg.aria === 'Goal: ' + LONG_GOAL && lg.h <= 24, JSON.stringify(lg));
            const upd = await ev(`(() => [...document.querySelectorAll('#group-table-view tbody tr td[data-key="updated"]')].map(td => [td.textContent.trim(), [td, ...td.querySelectorAll('*')].some(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible')]))()`);
            check(`${label}: the Updated column is whole (the Goal column does not take its room)`, upd.length === ITEMS.length && upd.every(([, cut]) => !cut), JSON.stringify(upd));
            check(`${label}: a short goal is whole`, by('short-goal.md').goal && !by('short-goal.md').goal.cut && by('short-goal.md').goal.text === 'Ship the beta');
            check(`${label}: a file with no task, and a task with no goal, have an empty Goal cell`, by('no-task-notes.md').goal === null && by('no-task-notes.md').cell === '' && by('no-goal-task.md').goal === null && by('no-goal-task.md').cell === '', JSON.stringify([by('no-task-notes.md'), by('no-goal-task.md')]));
            await shot(`artifact-goal-column-${label}`);
            await ev(`document.querySelector('#group-table-view [data-goal-link="3"]').click(); true`);
            await waitFor(`location.pathname.startsWith('/inbox/goals')`, `${label}: the goal link opens the goal in the Inbox`, 6000);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} artifact Goal column checks passed`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
