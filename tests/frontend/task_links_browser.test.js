// Every board-task entry opens the same team Tasks page and URL (#8062).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'task-links-' + Date.now().toString(36), title = 'One task destination';
    const S = `(window.__coralStatic || '/static/')`;
    const api = (path, body) => ev(`fetch(${JSON.stringify(path)}, { method: 'POST', headers: {'Content-Type':'application/json'}, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => { if (!r.ok) throw Error(r.status); return r.json(); })`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        // The ordinary CDP shard permits unauthenticated reads/posts with a claimed sender.
        // A reply intentionally has no claimed sender: sign in as the fixture's Operator.
        if (process.env.CORAL_TEST_DATA_DIR) assert.equal(await ev(`fetch('/auth/password', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'coral-cdp-suites-test-password',keep:false})}).then(r=>r.status)`), 200, 'fixture Operator signs in for the real reply route');

        await api(`/api/board/${B}/subscribe`, { subscriber_id: 'Operator', job_title: 'Operator' });
        const g = await api(`/api/board/${B}/goals`, { title: 'Links goal', subscriber_id: 'Operator', outcome: 'One destination', done_when: 'All links agree' });
        const t = await api(`/api/board/${B}/tasks`, { title, body: 'Task body', created_by: 'Operator', assigned_to: 'Operator', goal_id: g.id });
        const id = t.id, want = `/team/${B}/tasks/${id}`;
        assert.ok(id && g.id, 'real task and goal created');
        const landed = async label => {
            await waitFor(`location.pathname === ${JSON.stringify(want)} && document.querySelector('#team-task-title')?.textContent.includes(${JSON.stringify(title)}) && document.querySelector('#team-tab-tasks')?.getAttribute('aria-selected') === 'true'`, label, 15000);
            assert.equal(await ev(`document.getElementById('task-detail-modal').getClientRects().length`), 0, label + ': no modal');
            console.log('PASS ' + label);
        };
        const team = tab => ev(`window.openTeamPage(${JSON.stringify(B)}, {tab:${JSON.stringify(tab)}}).then(() => true)`);
        await team('tasks');
        await waitFor(`!!document.querySelector('#team-panel-tasks .dt-primary[data-task-id="${id}"]')`, 'team task row');
        await ev(`document.querySelector('#team-panel-tasks .dt-primary[data-task-id="${id}"]').click(); true`);
        await landed('team Tasks row');
        await team('goals');
        await ev(`import(${S} + 'goals_view.js').then(m => m.openGoal(${g.id}, true)).then(() => true)`);
        await waitFor(`!!document.querySelector('.goal-list .dt-primary[data-task-id="${id}"]')`, 'goal task row');
        await ev(`document.querySelector('.goal-list .dt-primary[data-task-id="${id}"]').click(); true`);
        await waitFor(`!![...document.querySelectorAll('.goal-detail-pane button')].find(b => b.textContent.trim() === 'Open task page')`, 'the goal\'s preview with its Open task page');
        await ev(`[...document.querySelectorAll('.goal-detail-pane button')].find(b => b.textContent.trim() === 'Open task page').click(); true`);
        await landed('goal column row');
        await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
        await waitFor(`!!document.querySelector('#group-table-view .dt-primary[data-task-id="${id}"]')`, 'Inbox task row');
        await ev(`document.querySelector('#group-table-view .dt-primary[data-task-id="${id}"]').click(); true`);
        // since #8633 an Inbox row opens the task inside the Inbox, at its own path
        await waitFor(`location.pathname === ${JSON.stringify(`/inbox/tasks/${B}/${id}`)} && document.querySelector('#inbox-page .team-task-page')?.textContent.includes(${JSON.stringify(title)})`, 'Inbox Tasks row opens in the Inbox', 15000);
        console.log('PASS Inbox Tasks row');
        await waitFor(`!!document.querySelector('#inbox-page .ibx-reply-input')`, 'shared reply box');
        await ev(`(() => { const t=document.querySelector('#inbox-page .ibx-reply-input'); t.value='Keep this reply draft'; t.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
        await team('messages');
        await ev(`import(${S}+'task_navigation.js').then(m=>m.openTask(${JSON.stringify(B)},${id})).then(()=>true)`);
        await waitFor(`document.querySelector('#team-panel-item .ibx-reply-input')?.value === 'Keep this reply draft'`, 'draft survives navigation');
        await ev(`document.querySelector('#team-panel-item .ibx-send').click(); true`);
        await waitFor(`/Reply (sent|saved)/.test(document.querySelector('#team-panel-item .ibx-reply-status')?.textContent || '')`, 'reply submitted on canonical page', 10000, `({status:document.querySelector('#team-panel-item .ibx-reply-status')?.textContent,disabled:document.querySelector('#team-panel-item .ibx-send')?.disabled})`);
        await waitFor(`document.querySelector('#team-panel-item .ibx-thread')?.textContent.includes('Keep this reply draft')`, 'sent reply joins conversation');
        console.log('PASS reply draft, submit and conversation');
        await team('messages');
        await ev(`import(${S} + 'tasks.js').then(async () => { const {state}=await import(${S}+'state.js'); state.selectedTeam=${JSON.stringify(B)}; state.currentSession = { type: 'live', name: 'dock-agent', session_id: 'dock-agent-id', board_project: ${JSON.stringify(B)}, server: 'local' }; const b=document.createElement('button'); b.dataset.onClick='task-open'; b.dataset.kind='board'; b.dataset.taskId='${id}'; document.body.append(b); b.click(); b.remove(); return true; })`);
        // since #8788 an agent dock's task opens in the shared preview pane (the Operator's design), not on the team page
        await waitFor(`document.querySelector('#preview-pane .team-task-page')?.textContent.includes(${JSON.stringify(title)})`, 'dock task action opens the task in the preview', 15000);
        assert.equal(await ev(`document.getElementById('task-detail-modal').getClientRects().length`), 0, 'dock task action: no modal');
        console.log('PASS dock task action');
        await ev(`import(${S}+'state.js').then(m => { m.state.currentSession = null; return true; })`); // the dock's context is left
        await team('messages');
        await ev(`import(${S} + 'notifications.js').then(m => { m.showAlertNotification('Task assigned', 'Open your task', 'info', {url:${JSON.stringify(want)},label:'Open task'}); document.querySelector('.alert-notification-link').click(); return true; })`);
        await landed('notification task link');
        await team('messages');
        await ev(`import(${S} + 'inbox_coral.js').then(m => m.coralInboxAdapter.openTask({project:${JSON.stringify(B)},id:${id}})).then(() => true)`);
        await landed('shared Inbox adapter');
        await ev(`window.switchNavTab('tokens'); true`);
        await ev(`(async () => { const real=window.fetch; window.fetch=(u,o)=>new URL(String(u),location.origin).pathname==='/api/board/tasks' ? Promise.resolve(new Response(JSON.stringify({tasks:[{id:${id},board_id:${JSON.stringify(B)},title:${JSON.stringify(title)},status:'in_progress',cost_usd:1}]}),{headers:{'Content-Type':'application/json'}})) : real(u,o); try { const m=await import(${S}+'cost_dashboard.js'); await m.showCostDashboard(); const v=await import(${S}+'analytics_views.js'); v.selectView('task'); await m._refreshCostDashboard(); } finally { window.fetch=real; } return true; })()`);
        await waitFor(`!!document.querySelector('#cost-by-task .dt-primary')`, 'Analytics task row');
        await ev(`document.querySelector('#cost-by-task .dt-primary').click(); true`);
        await landed('Analytics By task row');
        await api(`/api/board/${B}/messages`, {subscriber_id:'Operator',content:`See task #${id}`});
        await team('messages');
        await waitFor(`!![...document.querySelectorAll('#mb-messages .mb-message')].find(r=>r.textContent.includes('See task #${id}'))`, 'board message');
        await ev(`(() => { const row=[...document.querySelectorAll('#mb-messages .mb-message')].find(r=>r.textContent.includes('See task #${id}')); row.querySelector('.mb-row-toggle').click(); row.querySelector('.mb-task-link').click(); return true; })()`);
        await landed('board message task reference');
        const paths = await ev(`import(${S}+'task_navigation.js').then(m => [m.taskHref('@remote/team name', 42),m.taskHref('team', '../../bad'),m.taskHref('', 42)])`);
        assert.equal(paths[0], '/team/@remote/team%20name/tasks/42');
        assert.deepEqual(paths.slice(1), ['', '']);
        console.log('PASS linked-server route and invalid task IDs');
        await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true});
        await Emulation.setTouchEmulationEnabled({enabled:true});
        await team('tasks');
        await ev(`document.querySelector('#team-panel-tasks .dt-primary[data-task-id="${id}"]').click(); true`);
        await landed('phone task row');
        await waitFor(`!!document.querySelector('#team-panel-item .ibx-reply-input')`, 'phone reply box');
        assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), true, 'phone task page has no horizontal overflow');
        const dir=process.env.CORAL_SCREENSHOT_DIR;
        if (dir) { require('node:fs').mkdirSync(dir,{recursive:true}); require('node:fs').writeFileSync(`${dir}/task-links-phone.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); }

    } finally { await removeBoards(ev,[B]).catch(()=>{}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
