// A goal link lands on its team page's Goals tab with that goal open, at the goal's own address (/team/<team>/goals/<id>), never on the old board page (/board/<team>) (#8048, the operator's "clicking a goal
// should jump to that goal view"). One check per place a goal is linked from outside the team page: the Inbox's Goals folder, a Needs you row's Goal, the Inbox task page's Goal button, and a task's
// Goal line in the task views (task-goal-open). Real board and goal on the isolated dev server (removed again); the one waiting agent is stood in on the page's live list.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const B = 'gl-' + Date.now().toString(36), TITLE = 'Ship the goal links';
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-' + B })).status, 200);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: TITLE, outcome: 'Every link', done_when: 'it is true' });
        assert.equal(g.status, 201, JSON.stringify(g)); const G = g.body.id;
        const t = await api('POST', `/api/board/${B}/tasks`, { title: 'A task with a goal', body: 'x', created_by: 'orch', priority: 'medium', assigned_to: 'Operator', goal_id: G });
        assert.ok(t.status < 300, JSON.stringify(t));
        const WANT = `/team/${B}/goals/${G}`;
        const home = async () => { await ev(`window.switchNavTab('agents'); window.history.replaceState(null, '', '/'); true`); };
        // the URL and the open goal are right, and the old board page was never the address
        const landed = async (where) => {
            await waitFor(`location.pathname === ${JSON.stringify(WANT)} && document.getElementById('goals-detail-title') && document.getElementById('goals-detail-title').textContent === ${JSON.stringify(TITLE)}`, `${where}: the team page's goal ${TITLE} at ${WANT}`, 15000);
            assert.equal(await ev(`location.pathname.startsWith('/board/')`), false, `${where}: not the board page`);
            await waitFor(`document.activeElement && document.activeElement.id === 'goals-detail-title'`, `${where}: the keyboard starts at the goal's heading`, 6000);
            assert.equal(await ev(`getComputedStyle(document.getElementById('team-page-view')).display !== 'none'`), true, `${where}: the team page is on screen`);
        };
        const inboxFolder = async (key, rowsSel) => {
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(key)})).then(() => true)`);
            await waitFor(`document.querySelectorAll(${JSON.stringify(rowsSel)}).length >= 1`, `the ${key} folder`, 15000);
        };

        console.log('1. The Inbox Goals folder');
        await inboxFolder('goals', '#group-table-view .dt-table tbody tr');
        await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr')].find(r => r.textContent.includes(${JSON.stringify(TITLE)})).querySelector('.dt-primary').click(); true`);
        await landed('Goals folder');
        console.log('   ✓');

        console.log('2. A Needs you row\'s Goal');
        await home();
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'), m = await import(${S} + 'inbox_tab.js'); state.liveSessions = [{ name: 'gl-agent', session_id: '00000001-0000-4000-8000-0000000000aa', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Goal Agent', working_directory: '/repo/a', waiting_for_input: true, waiting_kind: 'permission', waiting_since: new Date(Date.now() - 300000).toISOString(), board_project: ${JSON.stringify(B)}, goal: { id: ${G}, title: ${JSON.stringify(TITLE)} }, sleeping: false }]; m.updateInboxTab(); return true; })()`);
        await inboxFolder('needs', '#group-table-view .dt-table tbody tr');
        await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr .dt-link')].find(b => b.textContent === ${JSON.stringify(TITLE)}).click(); true`);
        await landed('Needs you');
        console.log('   ✓');

        console.log('3. The Inbox task page\'s Goal button');
        await home();
        await inboxFolder('tasks', '#group-table-view .dt-table tbody tr .dt-primary');
        await ev(`document.querySelector('#group-table-view .dt-table tbody tr .dt-primary').click(); true`);
        await waitFor(`!![...document.querySelectorAll('#team-panel-item .goals-facts dt')].find(x=>x.textContent==='Goal')?.nextElementSibling.querySelector('button')`, 'the task page with its Goal button', 15000);
        await ev(`[...document.querySelectorAll('#team-panel-item .goals-facts dt')].find(x=>x.textContent==='Goal')?.nextElementSibling.querySelector('button').click(); true`);
        await landed('Inbox task page');
        console.log('   ✓');

        console.log('4. A task\'s Goal line (task-goal-open)');
        await home();
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.selectedTeam = ${JSON.stringify(B)}; const b = document.createElement('button'); b.id = 'zz-goal-open'; b.setAttribute('data-on-click', 'task-goal-open'); b.setAttribute('data-goal-id', ${JSON.stringify(String(G))}); b.textContent = 'Goal'; document.body.append(b); b.click(); b.remove(); return true; })()`);
        await landed('task-goal-open');
        console.log('   ✓');
        console.log('PASS goal links: every one lands on the team page at /team/<team>/goals/<id> with the goal open, never /board/<team>');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
