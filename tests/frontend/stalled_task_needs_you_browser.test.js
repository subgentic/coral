// A stopped agent that holds an in-progress task is a Needs you item (#16921, walk 42 H1): the person pressed Stop on an agent that had claimed task #3, and for six minutes Needs you said 0, the team header said
// All well and the task stayed In progress. The live row's stalled_task (the server's, after two minutes with no turn) makes the row an item "Stopped with task #3 in progress" with Restart (one tap) and
// Reassign (opens the task), counts in the Inbox, makes the team header say "1 needs attention", and leaves with the row when the agent takes a turn. No Dismiss: nothing is waited on. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const teams = [];
    const S = `(window.__coralStatic||'/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            const team = 'stalled-task-' + Date.now().toString(36); teams.push(team);
            await ev(`fetch('/api/board/'+${JSON.stringify(team)}+'/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'QA Engineer',job_title:'QA Engineer'})}).then(r=>r.ok)`);
            await ev(`(() => { localStorage.removeItem('coral-inbox-needs-filters'); window.__m.add('stalled-agent', 'QA Engineer', 3, { sleeping: false });
                const row = window.T.state.liveSessions.find(s => s.session_id === 'stalled-agent-id'); window.__stalled = row;
                Object.assign(row, { board_project: ${JSON.stringify(team)}, stalled_task: { team: ${JSON.stringify(team)}, task_id: 3, title: 'Check the calculator', since: new Date(Date.now() - 180000).toISOString(), agent: 'QA Engineer' } });
                window.T.render.renderLiveSessions(window.T.state.liveSessions); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`!!document.querySelector('#group-table-view .inbox-stalled-restart')`, `${width}: the stalled row's Restart`, 8000);
            const count = () => ev(`import(${S} + 'inbox_tab.js').then(m => m.waitingCount())`);
            assert.equal(await count(), 1, `${width}: a stopped agent holding a task counts in the Inbox`);
            const text = await ev(`document.querySelector('#group-table-view').textContent`);
            assert.match(text, /Stopped with task #3 in progress/, `${width}: the row says what happened: ${text.slice(0, 200)}`);
            assert.equal(await ev(`document.querySelector('#group-table-view .inbox-stalled-restart').textContent.trim()`), 'Restart');
            assert.equal(await ev(`document.querySelector('#group-table-view .inbox-stalled-restart').classList.contains('btn-primary')`), true, 'Restart is the one primary action');
            assert.match(await ev(`document.querySelector('#group-table-view .inbox-stalled-reassign').getAttribute('href')`), new RegExp(`/tasks/3$`), 'Reassign opens the task');
            assert.equal(await ev(`document.querySelectorAll('#group-table-view .inbox-dismiss, #group-table-view .inbox-answer').length`), 0, 'nothing is waited on: no Dismiss, no answers');
            if (width === 390) assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view [role="menuitem"]')].map(i => i.textContent.trim()).filter(t => t === 'Restart' || t === 'Reassign').sort()`), ['Reassign', 'Restart'], 'the phone row\'s menu carries Restart and Reassign');
            if (width === 390) assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view [role="menuitem"]')].map(i => i.textContent.trim()).filter(t => t === 'Dismiss')`), [], 'the phone menu has no Dismiss');

            await ev(`window.__restarts = []; const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = String(u); if (/\\/restart/.test(url) && (o.method || 'GET') === 'POST') { window.__restarts.push(url); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })); } return R(u, o); }; true`);
            await ev(`document.querySelector('#group-table-view .inbox-stalled-restart').click(); true`);
            await waitFor(`window.__restarts.length >= 1`, `${width}: Restart restarts the agent`, 8000);

            await ev(`globalThis.__coralAttentionGraceMs = 4000; window.openTeamPage(${JSON.stringify(team)})`);
            await waitFor(`/^1 needs? attention$/.test(document.querySelector('#team-page-status')?.textContent.trim() || '')`, `${width}: the team header says 1 needs attention`, 20000);

            await ev(`delete window.__stalled.stalled_task; window.T.render.renderLiveSessions(window.T.state.liveSessions); true`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            assert.equal(await count(), 0, `${width}: the row leaves when the agent takes a turn`);
        }
        console.log('PASS a stopped agent that holds a task is a Needs you item with Restart and Reassign, counted in the header, and clears with its next turn');
    } finally { await removeBoards(ev, teams).catch(() => {}); await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
