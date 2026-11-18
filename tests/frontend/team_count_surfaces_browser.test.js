// #17625: each reported surface agrees with its filtered rows or confirmed action.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { GOALS_STUB } = require('./helpers/goals_stub');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [], boards = [], S = `(window.__coralStatic || '/static/')`;
    const check = (ok, name, value) => { if (!ok) problems.push(`${name}: ${JSON.stringify(value)}`); };
    const shot = async name => { if (!process.env.CORAL_SCREENSHOT_DIR) return; await ev(framesJs(3)); fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            const team = 'counts17625-' + width + '-' + Date.now().toString(36); boards.push(team);
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => { if (!r.ok) throw Error('seed board'); return true; })`);
            await ev(GOALS_STUB);
            await ev(`(() => { window.__goals = window.__goals.filter(g => g.state === 'done'); window.__stopped = false;
                const real = fetch, json = x => Promise.resolve(new Response(JSON.stringify(x), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const done = [1,2,3].map(id => ({ id, title: 'Completed ' + id, status: 'completed', created_by: 'Boss', assigned_to: 'Boss', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
                window.fetch = (u,o={}) => { const url = new URL(String(u), location.href), p=url.pathname;
                    if (p === '/api/board/${team}/tasks' && (!o.method || o.method === 'GET')) return json({ tasks: done, total_open: 0, total_completed: 3, total: 3, completed_since: 3, next_cursor: '' });
                    if (p === '/api/board/${team}/status') return json({ agents: [{ name: 'Boss', subscriber_id: 'Boss', availability: 'offline', open_tasks: 1 }] });
                    if (p === '/api/board/tasks') return json({ tasks: [1,2].map(id => ({ id: 10+id, title: 'Queued for Operator ' + id, board_id: '${team}', assigned_to: 'Operator', status: 'pending', priority: 'medium', updated_at: new Date().toISOString() })) });
                    if (p === '/api/sessions/history/counts') return json({ all: 3, active: window.__stopped ? 0 : 3, group: 0, notes: 0, starred: 0, archived: 0, by_agent_type: {}, tags: [] });
                    if (p === '/api/sessions/live/team/${team}/kill') { window.__stopped = true; return json({ ok: true, sessions_killed: 3 }); }
                    return real(u,o); };
                for (const n of ['boss', 'worker1', 'worker2']) window.__m.add(n, n, 1, { sleeping: false, board_project: '${team}' });
                return true; })()`);
            await ev(framesJs(3));
            await ev(`window.openTeamPage('${team}', { tab: 'tasks' }).then(() => true)`);
            await waitFor(`!!document.querySelector('#team-panel-tasks [data-filter="open"]') && !/Loading tasks/.test(document.getElementById('team-panel-tasks').textContent)`, 'team tasks loaded');
            const tasks = await ev(`({ pill: document.querySelector('#team-panel-tasks [data-filter="open"]').textContent.trim(), rows: document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length })`);
            check(/Open\s*0/.test(tasks.pill) && tasks.rows === 0, `${width} item1 Open excludes completed tasks (#17130)`, tasks);
            await shot(`tasks-${width}`);
            await ev(`window.openTeamPage('${team}', { tab: 'goals' }).then(() => true)`);
            await waitFor(`!/Loading goals/.test(document.getElementById('team-panel-goals').textContent) && /Active/.test(document.getElementById('team-panel-goals').textContent)`, 'goal filters loaded');
            const goals = await ev(`({ rows: document.querySelectorAll('#team-panel-goals tbody tr.dt-row').length, text: document.getElementById('team-panel-goals').textContent })`);
            check(goals.rows === 0 && /No active goals/.test(goals.text), `${width} item2 Active excludes Done goals`, goals);
            await ev(`import(${S} + 'inbox_sidebar.js').then(m => m.refreshTeamNeedsCount('${team}', true)).then(() => true)`);
            await ev(framesJs(3));
            const health = await ev(`import(${S} + 'inbox_sidebar.js').then(m => ({ source: m.teamNeedsCount('${team}'), text: document.getElementById('team-page-status').textContent, button: document.getElementById('team-page-health').textContent, shown: !document.getElementById('team-page-health').hidden }))`);
            check(health.source.complete && health.source.value === 0 && !health.shown && !/need.*attention/.test(health.text), `${width} item3 header agrees with Needs you`, health);
            await shot(`goals-health-${width}`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_sidebar.js').then(m => m.showInbox({ folder: 'tasks' })).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length >= 2 || document.querySelectorAll('#group-table-view [data-task-id]').length >= 2`, 'queued Operator tasks');
            const count = await ev(`import(${S} + 'inbox_tab.js').then(m => m.inboxCountsNow().tasks)`);
            check(count === 2, `${width} item4 sidebar Tasks includes queued Operator tasks`, count);
            await shot(`sidebar-tasks-${width}`);
            await ev(`import(${S} + 'mailbox_chats.js').then(m => m.loadChatCounts()).then(() => true)`);
            const before = await ev(`import(${S} + 'mailbox_chats.js').then(m => m.folderCount('chats-active'))`);
            assert.equal(before, 3);
            await ev(`window.killBoard('${team}'); true`);
            await waitFor(`document.getElementById('confirm-modal').getClientRects().length > 0`, 'Stop agents confirmation');
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`window.__stopped && !(T.state.liveSessions || []).some(s => s.board_project === '${team}')`, 'confirmed stop drops team rows');
            let dropped = false;
            try { await waitFor(`import(${S} + 'mailbox_chats.js').then(m => m.folderCount('chats-active') === 0)`, 'Active now drops immediately', 1200); dropped = true; } catch { /* collect this finding along with the other surfaces */ }
            check(dropped, `${width} item6 Active now drops after Stop without poll`, await ev(`import(${S} + 'mailbox_chats.js').then(m => m.folderCount('chats-active'))`));
            await ev(`window.openTeamPage('${team}', { tab: 'goals' }).then(() => true)`);
            await ev(`import(${S} + 'message_board.js').then(m => m.deleteTeam('${team}')).then(() => true)`);
            await waitFor(`document.getElementById('confirm-modal').getClientRects().length > 0`, 'Remove team confirmation');
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`!T.state.selectedTeam`, 'removed team deselected');
            const removed = await ev(`({ visible: document.getElementById('team-page-view').getClientRects().length > 0, path: location.pathname })`);
            check(!removed.visible && !removed.path.includes(team), `${width} item5 removed team header goes away`, removed);
            await shot(`removed-${width}`);
        }
        assert.deepEqual(problems, []);
        console.log('team_count_surfaces: ok');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
