// Selecting tasks on the team page's Tasks tab (#7743): checkboxes at the left, the selection bar takes the toolbar's line with "N selected", Reassign, Set priority and Cancel tasks (the danger one confirms in the bar), Clear;
// the actions call each task's own route; the search field stays while selecting. Real board on the isolated dev server (removed again). Desktop; the phone's Select mode is data_table_browser's.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const B = 'tb-' + Date.now().toString(36);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await ev(`new Promise(r => setTimeout(r, 400))`); /* sleep-ok: a screenshot waits out transitions */ fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const [id, jt] of [['orch', 'Orchestrator'], ['dev', 'Developer']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' })).status, 200);
        const ids = [];
        for (const [t, p] of [['One', 'low'], ['Two', 'low'], ['Three', 'low'], ['Four', 'low']]) { const r = await api('POST', `/api/board/${B}/tasks`, { title: t, body: 'x', created_by: 'orch', priority: p }); assert.ok(r.status < 300, JSON.stringify(r)); ids.push(r.body.id || r.body.task.id); }
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-tasks .dt-table tbody tr').length === 4`, 'the four tasks', 15000);
        const row = (i) => `document.querySelectorAll('#team-panel-tasks .dt-table tbody .dt-check input')[${i}]`;
        const state = () => ev(`(() => { const r = document.querySelector('#team-panel-tasks .list-bar-search-row'); const bar = document.querySelector('#team-panel-tasks .dt-bar'); return { selecting: r.classList.contains('team-toolbar-selecting'), count: bar && !bar.hidden ? bar.querySelector('.dt-bar-count').textContent : '', search: !!r.querySelector('.list-bar-search') && getComputedStyle(r.querySelector('.list-bar-search')).display !== 'none', actions: bar ? [...bar.querySelectorAll('button')].map(b => b.textContent) : [] }; })()`);
        assert.equal((await state()).selecting, false, 'not selecting at first');
        await ev(`${row(0)}.click(); ${row(1)}.click(); true`);
        let s = await state();
        assert.deepEqual([s.selecting, s.count, s.search], [true, '2 selected', true], 'the bar takes the line, the search field stays ' + JSON.stringify(s));
        assert.deepEqual(s.actions, ['Reassign', 'Set priority', 'Cancel tasks', 'Clear'], 'the actions');
        const gaps = await ev(`(() => { const bs = [...document.querySelectorAll('#team-panel-tasks .dt-bar > *')].map(e => e.getBoundingClientRect()); return bs.slice(1).map((r, i) => Math.round(r.left - bs[i].right)); })()`);
        assert.ok(gaps.slice(0, -1).every(g => g <= 12), 'the bar\'s actions are close together, 8 px apart ' + JSON.stringify(gaps)); // the last gap is to Clear, alone at the right
        assert.ok(gaps[gaps.length - 1] >= 0, 'Clear follows the actions');
        await shot('tasks-selected');
        // Set priority: asks for the value in the bar, calls each task's route
        await ev(`[...document.querySelectorAll('#team-panel-tasks .dt-bar-action')].find(b => b.textContent === 'Set priority').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-tasks .dt-bar-choice')`, 'the priority choice');
        await ev(`(() => { const p = document.querySelector('#team-panel-tasks .dt-bar-choice'); p.value = 'high'; return true; })()`);
        await ev(`document.querySelector('#team-panel-tasks .dt-bar-apply').click(); true`);
        await waitFor(`!document.querySelector('#team-panel-tasks .dt-bar-choice')`, 'the priority applied and the bar closed', 10000);
        s = await state(); assert.equal(s.selecting, false, 'the selection is cleared and the toolbar is back after the action');
        for (const id of [ids[0], ids[1]]) assert.equal((await api('GET', `/api/board/${B}/tasks/${id}`)).body.priority || (await api('GET', `/api/board/${B}/tasks/${id}`)).body.task.priority, 'high', 'the server has it');
        // Reassign
        const reassignedId = await ev(`${row(2)}.closest('tr').dataset.key.slice(1)`);
        await ev(`${row(2)}.click(); true`);
        await ev(`[...document.querySelectorAll('#team-panel-tasks .dt-bar-action')].find(b => b.textContent === 'Reassign').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-tasks .dt-bar-choice') && document.querySelector('#team-panel-tasks .dt-bar-choice').options.length > 1`, 'the members');
        await ev(`(() => { document.querySelector('#team-panel-tasks .dt-bar-choice').value = 'dev'; return true; })()`);
        await ev(`document.querySelector('#team-panel-tasks .dt-bar-apply').click(); true`);
        await waitFor(`[...document.querySelectorAll('#team-panel-tasks .dt-table tbody tr')].some(r => r.querySelector('td[data-key="who"] [role=img]')?.getAttribute('aria-label') === 'dev')`, 'a task is dev\'s', 10000);
        const reassigned = (await api('GET', `/api/board/${B}/tasks/${reassignedId}`)).body;
        assert.equal((reassigned.task || reassigned).assigned_to, 'dev', 'the server records the chosen assignee');
        // Cancel tasks confirms in the bar: Keep puts it away, the action runs
        await ev(`${row(0)}.click(); true`);
        await ev(`[...document.querySelectorAll('#team-panel-tasks .dt-bar-action')].find(b => b.textContent === 'Cancel tasks').click(); true`);
        assert.equal(await ev(`document.querySelector('#team-panel-tasks .dt-bar-confirm').textContent`), 'Cancel 1 task?', 'the confirmation in the bar');
        await ev(`document.querySelector('#team-panel-tasks .dt-bar-keep').click(); true`);
        assert.equal(await ev(`document.querySelectorAll('#team-panel-tasks .dt-table tbody tr').length`), 4, 'Keep leaves every task');
        await ev(`[...document.querySelectorAll('#team-panel-tasks .dt-bar-action')].find(b => b.textContent === 'Cancel tasks').click(); [...document.querySelectorAll('#team-panel-tasks .dt-bar button')].find(b => b.classList.contains('dt-danger') && b.textContent === 'Cancel tasks').click(); true`);
        await waitFor(`document.querySelectorAll('#team-panel-tasks .dt-table tbody tr').length === 3`, 'the cancelled task leaves the open list', 10000);
        console.log('PASS Tasks: select, set priority, reassign and cancel in bulk, through the selection bar');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
