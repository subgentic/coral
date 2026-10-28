// The Tasks tab pages a big open set (#9121, Goal #85): the default list answers 50 open tasks and a cursor, the tab shows them with "Load more open tasks" and the exact totals, loading more follows the cursor (open tasks, then the done
// ones), a refresh reads the loaded pages again, and the first read is a small part of the bytes of the whole open set (the tab polls it every 10 s). A real board of 360 open and 5 done tasks on the isolated dev server (removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const B = 'open-paging-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const post = (p, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(p)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        assert.ok((await post('/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
        await ev(`(async () => { const mk = (i) => fetch('/api/board/${B}/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Open task ' + i, body: 'x'.repeat(300), created_by: 'Boss', priority: i % 7 === 0 ? 'high' : 'medium', assigned_to: 'Boss' }) }).then(r => { if (!r.ok) throw new Error('fixture ' + r.status); });
            for (let i = 0; i < 360; i += 20) await Promise.all(Array.from({ length: 20 }, (_, k) => mk(i + k))); return true; })()`);
        for (let i = 0; i < 5; i++) {
            const t = await post('/tasks', { title: 'Done task ' + i, body: 'x', created_by: 'Boss', priority: 'medium', assigned_to: 'Boss' }); assert.ok(t.status < 300);
            const id = t.body.id || t.body.task.id;
            assert.ok((await post('/tasks/claim', { subscriber_id: 'Boss', task_id: id })).status < 300);
            assert.ok((await post(`/tasks/${id}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
        }
        // the bytes of every open task, read as the old default list read them
        const whole = await ev(`(async () => { let cursor = '', bytes = 0, n = 0; for (let i = 0; i < 10; i++) { const r = await fetch('/api/board/${B}/tasks?status=open&limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); const t = await r.text(); bytes += t.length; const j = JSON.parse(t); n += j.tasks.length; cursor = j.next_cursor; if (!cursor) break; } return { bytes, n }; })()`);
        assert.equal(whole.n, 360);
        await ev(`window.__tasksReads = []; { const w = window.fetch; window.fetch = (u, o) => { const p = w(u, o); if (/\\/api\\/board\\/${B}\\/tasks\\?/.test(String(u)) && !/status=/.test(String(u))) p.then(r => r.clone().text()).then(t => window.__tasksReads.push({ url: String(u), bytes: t.length, rows: JSON.parse(t).tasks.length })).catch(() => {}); return p; }; } true`);
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr[data-key], #team-panel-tasks tbody tr.dt-row').length > 0`, 'the tasks', 20000);
        await waitFor(`window.__tasksReads.some(r => /limit=50(&|$)/.test(r.url))`, 'the first read', 10000);
        const first = await ev(`window.__tasksReads.find(r => /limit=50(&|$)/.test(r.url))`);
        assert.equal(first.rows, 50, 'the first read is one page of open tasks: ' + JSON.stringify(first));
        assert.ok(first.bytes * 4 < whole.bytes, `the first read is a small part of the open set's bytes (${first.bytes} of ${whole.bytes})`);
        const shown = () => ev(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length`);
        assert.equal(await shown(), 50, 'fifty rows are drawn');
        assert.equal(await ev(`/Load more open tasks/.test(document.getElementById('team-panel-tasks').textContent)`), true, 'with a Load more open tasks button');
        await shot('tasks-open-paging-1280');
        for (let i = 0; i < 10 && await ev(`/Load more open tasks/.test(document.getElementById('team-panel-tasks').textContent)`); i++) {
            const n = await shown();
            await ev(`[...document.querySelectorAll('#team-panel-tasks .goals-more')].find(b => /Load more open tasks/.test(b.textContent)).click(); true`);
            await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length > ${n}`, 'the next page', 10000);
        }
        assert.equal(await ev(`[...document.querySelectorAll('#team-panel-tasks tbody tr.dt-row')].filter(r => /Open task/.test(r.textContent)).length`), 360, 'every open task is there once the pages are loaded');
        // a task of the first page finishes, then a refresh: it must not stay open on screen, the pages beyond the five re-read are dropped and Load more fetches them again (#9153)
        const finished = await ev(`fetch('/api/board/${B}/tasks?limit=1').then(r => r.json()).then(j => j.tasks[0])`);
        assert.ok((await post('/tasks/claim', { subscriber_id: 'Boss', task_id: finished.id })).status < 300);
        assert.ok((await post(`/tasks/${finished.id}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
        const reads = (await ev(`window.__tasksReads.length`));
        await ev(`import((window.__coralStatic || '/static/') + 'team_tasks_page.js').then(m => m.loadTasks()).then(() => true)`);
        await waitFor(`window.__tasksReads.length > ${reads}`, 'the refresh', 10000);
        await ev(`new Promise(r => setTimeout(r, 1500))`); // sleep-ok: the refresh's pages arrive one after another; the count of reads after it has no event
        const refreshReads = (await ev(`window.__tasksReads.length`)) - reads;
        assert.ok(refreshReads <= 6, `a refresh makes the first read and at most five more (${refreshReads})`);
        const openRows = () => ev(`[...document.querySelectorAll('#team-panel-tasks tbody tr.dt-row')].filter(r => /Open task/.test(r.textContent)).map(r => r.textContent)`);
        const afterRefresh = await openRows();
        assert.ok(!afterRefresh.some(t => t.includes(finished.title)), `the task that finished (${finished.title}) is not open on screen after the refresh`);
        assert.equal(afterRefresh.length, 300, 'the first page and the five re-read pages stay, the two beyond are dropped');
        assert.equal(await ev(`/Load more open tasks/.test(document.getElementById('team-panel-tasks').textContent)`), true, 'and Load more open tasks offers them again');
        for (let i = 0; i < 4 && await ev(`/Load more open tasks/.test(document.getElementById('team-panel-tasks').textContent)`); i++) {
            const n = (await openRows()).length;
            await ev(`[...document.querySelectorAll('#team-panel-tasks .goals-more')].find(b => /Load more open tasks/.test(b.textContent)).click(); true`);
            await waitFor(`[...document.querySelectorAll('#team-panel-tasks tbody tr.dt-row')].filter(r => /Open task/.test(r.textContent)).length > ${n}`, 'the next page again', 10000);
        }
        // the task that finished is a task finished today: the Open view keeps it too (#10604), as Done; it is not one of the open ones
        assert.equal((await openRows()).filter(t => !t.includes(finished.title)).length, 359, 'Load more fetched the rest: every open task but the finished one');
        console.log('PASS open set paging: 50 rows and ' + first.bytes + ' bytes for the first read instead of the whole ' + whole.bytes + '; Load more open tasks follows the cursor; a refresh read ' + refreshReads + ' pages of the 8 loaded and dropped the rest');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
