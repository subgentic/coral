// After a second goal (walk 18 M7, M8, #15305): the finished first goal stays on the Goals tab under the active one in its own "Done" group (it used to vanish into "No active goals / Show all 1"), the tab's badge says what
// the list shows, and the Tasks tab groups the tasks by goal (goal 1's finished tasks are not mixed with goal 2's new one). Real server, a made-up board (removed again). 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'g2-' + Date.now().toString(36);
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const open = async (path, what) => { await Page.navigate({ url: BASE + path }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); await waitFor(what, path, 20000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator' })).status < 300);
        const g1 = (await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Habit tracker', outcome: 'First app', done_when: 'It runs', state: 'active' })).body.id;
        const t1 = (await api('POST', `/api/board/${B}/tasks`, { title: 'Build the habit page', created_by: 'orch', goal_id: g1 })).body;
        assert.equal((await api('POST', `/api/board/${B}/tasks/${t1.id}/complete`, { subscriber_id: 'orch', message: 'built' })).status, 200); // finished: the board lists it after the open tasks, so goal 1's two tasks are not side by side unless the page groups them (#15364)
        assert.equal((await api('POST', `/api/board/${B}/goals/${g1}/close`, { subscriber_id: 'Operator', reason: 'shipped' })).status, 200);
        const rows = () => ev(`[...document.querySelectorAll('#team-panel-goals tbody tr')].map(r => ({ group: r.classList.contains('dt-group'), text: r.textContent.replace(/\\s+/g, ' ').trim() }))`);
        // only a finished goal: it is listed, in the Done group, not "No active goals"
        await open(`/team/${B}/goals`, `document.querySelectorAll('#team-panel-goals tbody tr').length > 0 || /No active goals/.test(document.body.innerText)`);
        let r = await rows();
        assert.ok(r.some(x => !x.group && /Habit tracker/.test(x.text)) && r.some(x => x.group && /Done \(1\)/.test(x.text)), 'the finished goal is listed under Done: ' + JSON.stringify(r));
        assert.ok(!/No active goals/.test(await ev(`document.body.innerText`)), 'no "No active goals"');
        // a second goal with a new task
        const g2 = (await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Habit tracker with reminders', outcome: 'Second app', done_when: 'It reminds', state: 'active' })).body.id;
        await api('POST', `/api/board/${B}/tasks`, { title: 'Add reminders', created_by: 'orch', goal_id: g2 });
        await api('POST', `/api/board/${B}/tasks`, { title: 'Polish the habit page', created_by: 'orch', goal_id: g1 }); // made after goal 2's task: the groups still go goal 1, goal 2 (#15364)
        await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Idea for later', state: 'proposed' }); // a goal the default list does not show: the badge is not the count of all goals
        await open(`/team/${B}/goals`, `document.querySelectorAll('#team-panel-goals tbody tr:not(.dt-group)').length >= 2`);
        r = await rows();
        const order = r.map(x => x.group ? 'G:' + x.text.replace(/\s*\(.*$/, '') : (/reminders/.test(x.text) ? 'second' : 'first'));
        assert.deepEqual(order.filter(x => x !== 'G:Active'), ['second', 'G:Done', 'first'], 'the active goal, then the Done group with the first: ' + JSON.stringify(r));
        const badge = await ev(`(document.querySelector('#team-tab-goals .team-tab-count') || {}).textContent`);
        assert.equal(badge, '2', 'the badge says what the list shows (two goals): ' + badge);
        // the Done group follows the search box: it hides when nothing finished matches, and shows when one does (#15364)
        const search = async text => { await ev(`(() => { const i = document.querySelector('#team-panel-goals input[type=search], #team-panel-goals input[placeholder="Search goals"]'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); };
        await search('reminders');
        await waitFor(`![...document.querySelectorAll('#team-panel-goals tbody tr.dt-group')].some(r => /Done/.test(r.textContent))`, 'the Done group hidden by a search that matches no finished goal', 4000);
        await search('Habit tracker');
        await waitFor(`[...document.querySelectorAll('#team-panel-goals tbody tr.dt-group')].some(r => /Done \\(1\\)/.test(r.textContent))`, 'the Done group back when the search matches the finished goal', 4000);
        await search('');
        // tasks: one group per goal
        await open(`/team/${B}/tasks`, `document.querySelectorAll('#team-panel-tasks tbody tr').length >= 2`);
        const heads = await ev(`[...document.querySelectorAll('#team-panel-tasks tbody tr.dt-group')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
        assert.ok(heads.length === 2 && /Habit tracker/.test(heads[0]) && /reminders/.test(heads[1]), 'the tasks are grouped by goal: ' + JSON.stringify(heads));
        const goalCells = await ev(`[...document.querySelectorAll('#team-panel-tasks tbody tr:not(.dt-group) [data-goal-link]')].map(a => a.textContent.trim())`);
        assert.ok(goalCells.length >= 2 && goalCells.every(c => /^#\d+ /.test(c)) && new Set(goalCells.map(c => c.slice(0, 4))).size === 2, 'the Goal column leads with the number, so near-identical names differ at the start: ' + JSON.stringify(goalCells));
        console.log('PASS after a second goal: the finished goal stays under Done, the badge is the list, tasks are grouped by goal');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
