// #15244 (Beta walk 12 H1, M1, M2, M7): a goal an agent closed looked the same as one the person closed, Reopen said nothing, the Close dialog said nothing about open tasks or agents, and the goal's Artifacts tab said 0
// while the team held files. Now: the goal page says "Closed as done by <agent>" with the reason, Reopen toasts what the team was told (and the board has the line), the Close dialog says what closing does, a goal that looks
// done says what Not yet does, and an empty Artifacts tab says the team has files (uploaded with no task). Real server, real stored file of a stood-in terminal session (removed again).
const assert = require('node:assert/strict');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'gcb-' + Date.now().toString(36);
    const api = (method, p, body, headers) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : JSON.stringify(typeof body === 'string' ? body : JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await load('/');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Closer QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: sname })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Habit tracker', outcome: 'A small app', done_when: 'It runs' });
        assert.equal(g.status, 201); const id = g.body.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
        const up = await api('POST', `/api/agent/artifacts?session_id=${sid}`, 'console.log("app");', { 'X-Artifact-Name': 'app.js', 'X-Artifact-Media-Type': 'text/javascript' }); // no task: not on the goal
        assert.equal(up.status, 201, JSON.stringify(up));
        const closed = await api('POST', `/api/board/${B}/goals/${id}/close`, { subscriber_id: 'orch', state: 'done', reason: 'Code written and read through' });
        assert.equal(closed.status, 200, JSON.stringify(closed)); assert.equal(closed.body.goal.closed_by, 'orch', 'the server keeps who closed it');

        await load(`/inbox/goals/${B}/${id}`);
        await waitFor(`!!document.querySelector('#inbox-page .goals-closed-by')`, 'the goal page says who closed it', 15000);
        assert.equal(await ev(`document.querySelector('#inbox-page .goals-closed-by').textContent`), 'Closed as done by orch. Reason: Code written and read through');
        assert.ok(await ev(`document.querySelector('#inbox-page .goals-closed-by').classList.contains('goals-closed-by-agent')`), 'an agent\'s close is marked');
        // the Artifacts tab: nothing on the goal, but the team has the file
        await ev(`document.querySelector('#inbox-page #goal-tab-artifacts').click(); true`);
        await waitFor(`!!document.querySelector('#inbox-page .goal-artifacts-elsewhere')`, 'the empty Artifacts tab says the team has files in all', 15000);
        assert.match(await ev(`document.querySelector('#inbox-page .goal-artifacts-elsewhere').textContent`), /No artifacts yet\..*This team has 1 file in all/);

        // Reopen: a toast says what the team was told, and the board has the line
        await ev(`document.querySelector('#inbox-page .goals-reopen').click(); true`);
        await waitFor(`[...document.querySelectorAll('.toast .toast-message')].some(t => /Reopened\\. The team read it on the board/.test(t.textContent))`, 'Reopen says what happened', 10000);
        const msgs = await api('GET', `/api/board/${B}/messages/all?limit=20`);
        assert.ok(JSON.stringify(msgs.body).includes('is reopened'), 'the board carries the reopen line');

        // the Close dialog says what closing does, with no task open
        await waitFor(`!!document.querySelector('#inbox-page .goals-close')`, 'Close goal is back', 10000);
        await ev(`document.querySelector('#inbox-page .goals-close').click(); true`);
        await waitFor(`!!document.querySelector('.goals-close-dialog .goals-close-effect')`, 'the Close dialog says what closing does', 10000);
        assert.match(await ev(`document.querySelector('.goals-close-dialog .goals-close-effect').textContent`), /stops no agent and no task/);
        console.log('PASS who closed a goal, what Reopen and Close do, and the team\'s files are said in words');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).catch(() => {})`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
