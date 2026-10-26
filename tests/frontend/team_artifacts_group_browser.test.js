// The team's Artifacts tab read by task or goal, and narrowed to one (#8593, Goal #61): a Group by select (none, Task, Goal) puts a head over each group's files (the shared data_table's group rows, "#1 Write the
// report, 2 files"), and Task and Goal selects (the ones the list has seen) become the server's task and goal filters, each with its chip ("Goal: Ship it"). Real board, goal and completed tasks on the isolated
// dev server (removed again).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'ag-' + Date.now().toString(36);
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const heads = () => ev(`[...document.querySelectorAll('#team-panel-artifacts tr.dt-group')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
    const names = () => ev(`[...document.querySelectorAll('#team-panel-artifacts [data-artifact-id]')].map(b => b.textContent)`);
    const pick = async (id, value) => { await ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const [sid, jt] of [['orch', 'Orchestrator'], ['be', 'Backend Dev']]) assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: sid, job_title: jt, session_name: sid + '-s' })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Ship it', outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201, JSON.stringify(g));
        const done = async (title, arts, goalId) => { const t = await api('POST', `/api/board/${B}/tasks`, { title, body: 'x', assigned_to: 'be', created_by: 'orch', priority: 'medium', goal_id: goalId }); assert.ok(t.status < 300, JSON.stringify(t)); const id = t.body.id;
            assert.ok((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'be', task_id: id })).status < 300);
            assert.ok((await api('POST', `/api/board/${B}/tasks/${id}/complete`, { subscriber_id: 'be', message: 'done', outcome: 'success', artifacts: arts })).status < 300); return id; };
        const t1 = await done('Write the report', [{ name: 'report.md', content: '# r' }, { name: 'notes.txt', content: 'n' }], g.body.id);
        const t2 = await done('Draw the graph', [{ name: 'graph.txt', content: 'g' }], g.body.id);
        const t3 = await done('Tidy up', [{ name: 'loose.md', content: 'l' }], null);

        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 4`, 'the four artifacts', 15000);

        console.log('1. Ungrouped to begin with');
        assert.deepEqual(await heads(), []);
        console.log('   ✓');

        console.log('2. Group by Task: a head per task, its files together, with the count');
        await pick('ta-group', 'task');
        await waitFor(`document.querySelectorAll('#team-panel-artifacts tr.dt-group').length === 3`, 'three task heads', 8000);
        const byTask = await heads();
        for (const want of [`#${t1} Write the report, 2 files`, `#${t2} Draw the graph, 1 file`, `#${t3} Tidy up, 1 file`]) assert.ok(byTask.some(h => h.toLowerCase().includes(want.toLowerCase())), want + ' in ' + JSON.stringify(byTask));
        const order = await ev(`[...document.querySelectorAll('#team-panel-artifacts tbody tr')].map(r => r.classList.contains('dt-group') ? 'H' : 'r').join('')`);
        assert.match(order, /^H(r+H)+r+$|^Hr+Hr+Hr+$/, 'a head, then its files: ' + order);
        await shot('artifacts-group-task');
        await ev(`document.querySelector('#team-panel-artifacts .list-bar-filter-btn, #team-panel-artifacts button[aria-label*="Filters" i], #team-panel-artifacts .list-bar-icon')?.click(); true`);
        await waitFor(`!!document.getElementById('ta-group') && document.getElementById('ta-group').offsetParent !== null`, 'the Filters menu with Group by', 5000);
        await shot('artifacts-group-menu');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await shot('artifacts-group-task-390');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        console.log('   ✓');

        console.log('3. Group by Goal: the goal\'s title, and No goal for the rest');
        await pick('ta-group', 'goal');
        await waitFor(`document.querySelectorAll('#team-panel-artifacts tr.dt-group').length === 2`, 'two goal heads', 8000);
        const byGoal = (await heads()).map(h => h.toLowerCase());
        assert.ok(byGoal.some(h => h.includes('ship it, 3 files')) && byGoal.some(h => h.includes('no goal, 1 file')), JSON.stringify(byGoal));
        await shot('artifacts-group-goal');
        console.log('   ✓');

        console.log('4. The Task and Goal filters: the server narrows, a chip says it');
        await pick('ta-group', '');
        await pick('ta-task', String(t1));
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 2`, 'the two files of the task', 8000);
        assert.deepEqual((await names()).sort(), ['notes.txt', 'report.md']);
        assert.ok(await ev(`[...document.querySelectorAll('#team-panel-artifacts .list-bar-chip, #team-panel-artifacts [class*=chip]')].some(c => c.textContent.includes('Task: #${t1} Write the report'))`), 'the Task chip');
        await pick('ta-task', '');
        await pick('ta-goal', String(g.body.id));
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 3`, 'the goal\'s three files', 8000);
        assert.equal(await ev(`[...document.querySelectorAll('#team-panel-artifacts [class*=chip]')].some(c => c.textContent.includes('Goal: Ship it'))`), true, 'the Goal chip');
        await shot('artifacts-goal-filter');
        console.log('   ✓');

        console.log('5. The grouping is kept for the team');
        await pick('ta-goal', ''); await pick('ta-group', 'task');
        await waitFor(`document.querySelectorAll('#team-panel-artifacts tr.dt-group').length === 3`, 'grouped again', 8000);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts tr.dt-group').length === 3`, 'still grouped by task after a reload', 15000);
        console.log('   ✓');
        console.log('PASS team artifacts group and filters: Group by task and goal, the Task and Goal filters with their chips, the grouping kept');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
