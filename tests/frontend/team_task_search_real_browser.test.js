// The team Tasks tab's search finds a task by a word of its title on the REAL server, no stubbed routes (walk 59, #17279: "Search tasks" said "No tasks match this search" for Write, rename, Python and tests while the
// three tasks showed with the box empty). Three tasks are made through the board's API; each word of a title, typed in the search at 1600 px, shows that task and not the others, and clearing it shows all three again.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const B = 'tsearch-' + Date.now().toString(36), problems = [];
    const post = (path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const TITLES = ['Write tests for rename_by_date.py', 'Implement the rename logic', 'Python script scaffold'];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        assert.equal((await post('/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status, 200);
        // the tasks are all Done, as a team that has finished its work has them (the walk's three): the Tasks tab opens on Open, so a search must reach the Done ones
        for (const [i, t] of TITLES.entries()) {
            const made = await post('/tasks', { title: t, body: 'details of ' + t, created_by: 'Operator' }); assert.equal(made.status, 201, 'made ' + t);
            await post('/tasks/claim', { subscriber_id: 'Boss', task_id: made.json.id }); await post('/tasks/' + made.json.id + '/complete', { subscriber_id: 'Boss', message: 'done ' + i });
        }
        await Page.navigate({ url: BASE + '/team/' + B + '/tasks' }); await Page.loadEventFired(); await install(); await coralReady();
        const rows = () => ev(`[...document.querySelectorAll('#team-panel-tasks tbody tr')].map(tr => tr.textContent.replace(/\\s+/g, ' ').trim())`);
        await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr').length >= 3 || /All/.test(document.querySelector('#team-panel-tasks').textContent)`, 'the tasks', 15000);
        const type = v => ev(`(() => { const i = document.querySelector('#team-panel-tasks input[aria-label="Search tasks"]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
        for (const [word, want] of [['Write', 0], ['rename', 0, 1], ['Python', 2], ['tests', 0], ['Imp', 1], ['Implement', 1]]) {
            await type(word);
            await settle(1200);
            const got = await rows();
            const wantTitles = TITLES.filter(t => t.toLowerCase().includes(word.toLowerCase()));
            const ok = got.length === wantTitles.length && wantTitles.every(t => got.some(r => r.includes(t)));
            if (!ok) problems.push(`searching "${word}" shows ${JSON.stringify(got.map(r => r.slice(0, 40)))}, want ${JSON.stringify(wantTitles)}`);
        }
        await type(''); await settle(1200);
        // the tasks are all Done and Open lists only open tasks (#17692: Open + Done = All), so the cleared search shows none under Open and all three under All
        if ((await rows()).length !== 0) problems.push('clearing the search leaves Done tasks under Open');
        await ev(`document.querySelector('#team-panel-tasks .goals-chip[data-filter="all"]').click()`); await settle(600);
        if ((await rows()).length !== 3) problems.push('clearing the search and choosing All does not show the three tasks again');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'the Tasks search:\n  ' + problems.join('\n  '));
    console.log('PASS the Tasks search finds a task by a word of its title');
})().catch(e => { console.error(e.message); process.exit(1); });
