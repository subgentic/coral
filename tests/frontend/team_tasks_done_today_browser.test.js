// #17130: Open is strictly unfinished, even when tasks completed today. Done and All retain results.
// A real board on the isolated dev server (removed again): two open tasks and one finished a moment ago. The Open view shows only the two unfinished tasks; Done shows the finished one; All shows all three.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const B = 'done-today-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const post = (p, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(p)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            if (!mobile) {
                assert.ok((await post('/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator' })).status < 300);
                for (const title of ['Still open one', 'Still open two']) assert.ok((await post('/tasks', { title, body: 'x', created_by: 'Boss', priority: 'medium' })).status < 300);
                const t = await post('/tasks', { title: 'Finished a moment ago', body: 'x', created_by: 'Boss', priority: 'medium', assigned_to: 'Boss' });
                assert.ok(t.status < 300); const id = t.body.id || t.body.task.id;
                assert.ok((await post('/tasks/claim', { subscriber_id: 'Boss', task_id: id })).status < 300);
                assert.ok((await post(`/tasks/${id}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
                // a task cancelled today is Done too, but has no result to look for: it leaves the Open view (tasks_bulk, v2.0.4)
                const c = await post('/tasks', { title: 'Cancelled a moment ago', body: 'x', created_by: 'Boss', priority: 'medium' });
                assert.ok(c.status < 300); const cid = c.body.id || c.body.task.id;
                const x = await post(`/tasks/${cid}/cancel`, { subscriber_id: 'Boss', message: 'not needed' }); // a cancel names its reason assert.ok(x.status < 300, 'the task is cancelled: ' + JSON.stringify(x));
            }
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks' }); true`);
            await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length >= 2`, `${w}: the tasks`, 20000);
            await waitFor(`!/Loading tasks/.test(document.getElementById('team-panel-tasks').textContent) && document.querySelector('#team-panel-tasks [data-filter="open"][aria-pressed="true"], #team-panel-tasks .goals-chip[aria-pressed="true"]')`, `${w}: the tasks are drawn and a view is chosen`, 20000);
            const titles = () => ev(`[...document.querySelectorAll('#team-panel-tasks tbody tr.dt-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            const pill = key => ev(`(() => { const b = [...document.querySelectorAll('#team-panel-tasks [data-filter="${key}"], #team-panel-tasks button')].find(x => x.dataset.filter === ${JSON.stringify(key)} || new RegExp('^' + ${JSON.stringify(key)}, 'i').test(x.textContent.trim())); return b ? { text: b.textContent.replace(/\\s+/g, ' ').trim(), pressed: b.getAttribute('aria-pressed') ?? b.getAttribute('aria-selected') } : null; })()`);
            let rows = await titles();
            assert.equal(rows.length, 2, `${w}: the default (Open) view shows only the two unfinished tasks: ${JSON.stringify(rows)}`);
            assert.ok(!rows.some(r => r.includes('Cancelled a moment ago')), `${w}: a task cancelled today is not in the default view: ${JSON.stringify(rows)}`);
            assert.ok(!rows.some(r => r.includes('Finished a moment ago')), `${w}: the task finished today is excluded from Open`);
            const open = await pill('open');
            assert.match(open.text, /Open\s*2/, `${w}: the Open count is what the table under it shows: ${JSON.stringify(open)}`);
            await ev(`[...document.querySelectorAll('#team-panel-tasks button')].find(b => b.dataset.filter === 'done').click(); true`);
            await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length === 2`, `${w}: the Done view`, 5000);
            rows = await titles();
            assert.ok(rows.length === 2 && rows.some(r => r.includes('Finished a moment ago')) && rows.some(r => r.includes('Cancelled a moment ago')), `${w}: Done shows the finished one and the cancelled one: ${JSON.stringify(rows)}`);
            await ev(`[...document.querySelectorAll('#team-panel-tasks button')].find(b => b.dataset.filter === 'all').click(); true`);
            await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length === 4`, `${w}: the All view`, 5000);
            await ev(`[...document.querySelectorAll('#team-panel-tasks button')].find(b => b.dataset.filter === 'open').click(); true`); // the page remembers the view a person chose: the next width starts on the default (Open) again
        }
        console.log('\nPASS Open excludes tasks finished or cancelled today');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
