// The team page's Tasks tab carries what the old dock tab had (#7453, the inventory): the search, Filters and Sort bar (a search, a filter or an order the default list does not have asks the task query, GET /api/board/tasks, whose answer is paged with
// a total: "Showing 2 of 3" and Load more), New task, and on a task's page the cost and what blocks it. The board's tasks and the query route are stubbed in the page. 1600 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-tasks-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const stub = () => ev(`(() => { const R = window.fetch.bind(window); window.__q = [];
        const T = (id, title, status, extra = {}) => ({ id, title, status, priority: 'high', created_by: 'Orchestrator', assigned_to: 'Backend Dev', created_at: '2026-10-25T06:00:00Z', ...extra });
        const ALL = [T(1, 'Fix the login bug', 'in_progress'), T(2, 'Fix the logout bug', 'pending'), T(3, 'Write docs', 'pending', { blocked_by: [{ task_id: 1, title: 'Fix the login bug', satisfied: false }], cost_usd: 1.5, body: '- first point\\n- second point\\n\\n<img src=x onerror="window.__pwn=1"> <script>window.__pwn=2</script>' })];
        const j = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/board/tasks') { window.__q.push(url.search); const q = (url.searchParams.get('q') || '').toLowerCase(); const hit = ALL.filter(t => !q || t.title.toLowerCase().includes(q)); if (url.searchParams.getAll('status').includes('completed')) return j({ tasks: [], next_cursor: '', total: 0, truncated: false }); // the done phase has none
            const cur = url.searchParams.get('cursor'); const page = cur ? hit.slice(1) : hit.slice(0, 1); return j({ tasks: page, next_cursor: !cur && hit.length > 1 ? 'next' : '', total: hit.length, truncated: false }); }
            if (/^\\/api\\/board\\/[^/]+\\/tasks$/.test(url.pathname)) { (window.__taskReads = window.__taskReads || []).push(url.search); if (url.searchParams.get('counts') === '1') return j({ tasks: [], total_open: 3, total_completed: 1 }); } if (/^\\/api\\/board\\/[^/]+\\/tasks$/.test(url.pathname)) return j({ tasks: [...(window.__more ? [...ALL, T(4, 'A task made while the tab was open', 'pending')] : ALL), T(9, 'Finished long ago', 'completed')], next_cursor: '', total_open: window.__more ? 4 : 3, total_completed: 1 });
            if (/^\\/api\\/board\\/[^/]+\\/tasks\\/3$/.test(url.pathname)) return j(ALL[2]);
            return R(u, o); }; return true; })()`);
    const rows = () => ev(`[...document.querySelectorAll('#team-panel-tasks tbody tr')].map(r => window.__na.text(r))`);
    const typeSearch = v => ev(`(() => { const i = document.querySelector('#team-panel-tasks input[aria-label="Search tasks"]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM); await stub(); await openTeam(ev, waitFor, TEAM); await goTab(ev, settle, 'Tasks'); await settle(600);
        await S.run('Hide completed is the Open chip, on by default, remembered until All is chosen', async () => {
            assert.equal((await rows()).length, 3, 'a finished task is not in the table by default');
            assert.ok(await ev(`document.querySelector('#team-panel-tasks .goals-chip[aria-pressed="true"]').dataset.filter === 'open'`), 'Open is the chosen chip');
            await ev(`document.querySelector('#team-panel-tasks .goals-chip[data-filter="all"]').click(); true`); await settle(300);
            assert.equal((await rows()).length, 4, 'All shows the finished one too');
            assert.equal(await ev(`localStorage.getItem('coral-hide-completed')`), 'false', 'the choice is kept under the old key');
            await ev(`document.querySelector('#team-panel-tasks .goals-chip[data-filter="open"]').click(); true`); await settle(300);
            assert.equal(await ev(`localStorage.getItem('coral-hide-completed')`), 'true');
        });
        await S.run('the tab counts read the two totals alone (counts=1), never a page of tasks to count them (#9100)', async () => {
            const reads = await ev(`window.__taskReads || []`);
            assert.ok(reads.includes('?counts=1'), 'the team page asks ?counts=1: ' + JSON.stringify(reads));
            assert.ok(!reads.includes('?limit=1'), 'and no longer ?limit=1, which returned every open task: ' + JSON.stringify(reads));
        });
        await S.run('the search bar is there and a search asks the task query (q), paged with a total and Load more', async () => {
            assert.ok(await ev(`!!document.querySelector('#team-panel-tasks input[aria-label="Search tasks"]')`), 'a search box named Search tasks');
            assert.equal((await rows()).length, 3, 'the default list: three open tasks');
            await typeSearch('fix'); await settle(700);
            const q = await ev(`window.__q`); assert.ok(q.some(s => /q=fix/.test(s) && /board=/.test(s)), `the query carries the search and the board: ${JSON.stringify(q)}`);
            assert.equal((await rows()).length, 1, 'the first page: one task');
            assert.ok(await ev(`/Showing 1 of 2/.test(document.getElementById('team-panel-tasks').textContent)`), 'Showing 1 of 2');
            assert.ok(await ev(`!!document.querySelector('#team-panel-tasks .list-bar-chip')`), 'a chip says what is on');
            assert.ok(await ev(`(() => { const b = [...document.querySelectorAll('#team-panel-tasks button')].find(x => /^Load more/.test(x.textContent.trim())); if (!b) return false; b.click(); return true; })()`), 'a Load more button'); await settle(600);
            assert.equal((await rows()).length, 2, 'the next page is added');
        });
        await S.run('clearing the search goes back to the default list', async () => {
            await typeSearch(''); await settle(700);
            assert.equal((await rows()).length, 3, 'three tasks again');
        });
        await S.run('the tab keeps itself current: a task made meanwhile shows when the window comes back to the front', async () => {
            assert.equal((await rows()).length, 3);
            await ev(`window.__more = true; window.dispatchEvent(new Event('focus')); true`); await settle(700);
            assert.equal((await rows()).length, 4, 'the new task is in the table without a click');
            await ev(`window.__more = false; window.dispatchEvent(new Event('focus')); true`); await settle(700);
        });
        await S.run('New task opens the task dialog', async () => {
            assert.ok(await ev(`(() => { const b = [...document.querySelectorAll('#team-panel-tasks button')].find(x => /^\\+ Task$/.test(x.textContent.trim())); if (!b) return false; b.click(); return true; })()`), 'a New task button'); await settle(500);
            assert.ok(await ev(`(() => { const m = document.getElementById('create-task-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`), 'the create task dialog is open');
            await ev(`window.hideCreateTaskModal && window.hideCreateTaskModal(); true`); await settle(200);
        });
        await S.run("a task's page shows what blocks it and its cost", async () => {
            await ev(`(() => { const b = [...document.querySelectorAll('#team-panel-tasks .dt-primary')].find(x => /Write docs/.test(x.textContent)); b.click(); return true; })()`); await settle(600);
            await waitFor(`!!document.querySelector('#team-panel-item .team-task-extra')`, 'the details under the facts (blocked by, cost)', 4000);
            const t = await ev(`window.__na.text(document.getElementById('team-panel-item'))`);
            assert.ok(/Blocked By\s*unmet\s*#1 — Fix the login bug/i.test(t), `Blocked by names the task: ${t.slice(0, 400)}`); assert.ok(/Cost\s*\$1\.50/.test(t), 'Cost');
        });
        await S.run("the description reads as the Inbox's does: Markdown bullets, and text from an agent is never markup (no script, no image, nothing runs)", async () => {
            await waitFor(`!!document.querySelector('#team-panel-item .team-task-md')`, 'the description is rendered', 4000);
            const d = await ev(`(() => { const item = document.getElementById('team-panel-item'), md = item.querySelector('.team-task-md'); return { items: [...md.querySelectorAll('li')].map(l => l.textContent.trim()), raw: /^\\s*-\\s/.test(md.textContent), live: item.querySelectorAll('script, img, [onerror]').length, pwn: window.__pwn === undefined, text: md.textContent }; })()`);
            assert.deepEqual(d.items, ['first point', 'second point'], `the bullets are a list: ${JSON.stringify(d)}`);
            assert.equal(d.raw, false, 'no raw hyphen starts the text'); assert.equal(d.live, 0, 'no script or image element came out of the text'); assert.equal(d.pwn, true, 'nothing ran');
            assert.ok(/<img src=x/.test(d.text) || /onerror/.test(d.text) || d.text.length > 0, 'the markup is shown as text or dropped, never as an element');
        });
        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
