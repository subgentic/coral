// #10604 (Beta team page pass), 1: the Tasks tab's default view (Open) keeps a task that finished today, so what an agent just did is not behind Show all: its result is the first thing a person looks for.
// A real board on the isolated dev server (removed again): two open tasks and one finished a moment ago. The Open view shows all three and counts them; Done shows the finished one; All shows all three.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const B = 'done-today-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const post = (p, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(p)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            if (!mobile) {
                assert.ok((await post('/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
                for (const title of ['Still open one', 'Still open two']) assert.ok((await post('/tasks', { title, body: 'x', created_by: 'Boss', priority: 'medium' })).status < 300);
                const t = await post('/tasks', { title: 'Finished a moment ago', body: 'x', created_by: 'Boss', priority: 'medium', assigned_to: 'Boss' });
                assert.ok(t.status < 300); const id = t.body.id || t.body.task.id;
                assert.ok((await post('/tasks/claim', { subscriber_id: 'Boss', task_id: id })).status < 300);
                assert.ok((await post(`/tasks/${id}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
            }
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks' }); true`);
            await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length >= 3`, `${w}: the tasks`, 20000);
            const titles = () => ev(`[...document.querySelectorAll('#team-panel-tasks tbody tr.dt-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
            const pill = key => ev(`(() => { const b = [...document.querySelectorAll('#team-panel-tasks [data-filter="${key}"], #team-panel-tasks button')].find(x => x.dataset.filter === ${JSON.stringify(key)} || new RegExp('^' + ${JSON.stringify(key)}, 'i').test(x.textContent.trim())); return b ? { text: b.textContent.replace(/\\s+/g, ' ').trim(), pressed: b.getAttribute('aria-pressed') ?? b.getAttribute('aria-selected') } : null; })()`);
            let rows = await titles();
            assert.equal(rows.length, 3, `${w}: the default (Open) view shows the two open tasks and the one finished today: ${JSON.stringify(rows)}`);
            assert.ok(rows.some(r => r.includes('Finished a moment ago')), `${w}: the task finished today is in the default view, not behind Show all`);
            const open = await pill('open');
            assert.match(open.text, /Open\s*3/, `${w}: the Open count is what the table under it shows: ${JSON.stringify(open)}`);
            await ev(`[...document.querySelectorAll('#team-panel-tasks button')].find(b => b.dataset.filter === 'done').click(); true`);
            await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length === 1`, `${w}: the Done view`, 5000);
            rows = await titles();
            assert.ok(rows.length === 1 && rows[0].includes('Finished a moment ago'), `${w}: Done shows only the finished one: ${JSON.stringify(rows)}`);
            await ev(`[...document.querySelectorAll('#team-panel-tasks button')].find(b => b.dataset.filter === 'all').click(); true`);
            await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length === 3`, `${w}: the All view`, 5000);
        }
        console.log('\nPASS the Open view keeps a task finished today');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
