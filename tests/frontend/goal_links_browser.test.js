// The Inbox Goals folder opens its shared goal view in place (#8571); its quiet team link opens the same goal on the team page.
// Other goal links retain their team-page destination (#8048): Needs you, the Inbox task page, and task-goal-open.
// Real board and goal on the isolated dev server (removed again); the waiting agent is stood in on the page's live list.
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
            await waitFor(`location.pathname === ${JSON.stringify(WANT)} && document.querySelector('#team-panel-goals #goals-detail-title') && document.querySelector('#team-panel-goals #goals-detail-title').textContent === ${JSON.stringify(TITLE)}`, `${where}: the team page's goal ${TITLE} at ${WANT}`, 15000);
            assert.equal(await ev(`location.pathname.startsWith('/board/')`), false, `${where}: not the board page`);
            await waitFor(`document.activeElement === document.querySelector('#team-panel-goals #goals-detail-title') && !!document.activeElement`, `${where}: the keyboard starts at the goal's heading`, 6000);
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
        const inboxGoal = `/inbox/goals/${B}/${G}`;
        await waitFor(`location.pathname === ${JSON.stringify(inboxGoal)} && document.querySelector('#inbox-page #goals-detail-title')?.textContent === ${JSON.stringify(TITLE)}`, 'Goals folder: the goal opens in the Inbox', 15000);
        assert.equal(await ev(`getComputedStyle(document.getElementById('inbox-page')).display !== 'none'`), true, 'the Inbox goal is on screen');
        assert.equal(await ev(`document.activeElement === document.querySelector('#inbox-page #goals-detail-title')`), false, 'Inbox goal: the heading does not take the focus (no ring round plain words, #7404; #8571)');
        assert.equal(await ev(`document.querySelector('#inbox-page .goal-team-link')?.getAttribute('href')`), WANT, 'the explicit team link addresses the same goal');
        await ev(`document.querySelector('#inbox-page .goal-team-link').click(); true`);
        await landed('Goals folder: Open on team page');
        console.log('   ✓');

        console.log('2. A Needs you row\'s Goal');
        await home();
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'), m = await import(${S} + 'inbox_tab.js'); state.liveSessions = [{ name: 'gl-agent', session_id: '00000001-0000-4000-8000-0000000000aa', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Goal Agent', working_directory: '/repo/a', waiting_for_input: true, waiting_kind: 'permission', waiting_since: new Date(Date.now() - 300000).toISOString(), board_project: ${JSON.stringify(B)}, goal: { id: ${G}, title: ${JSON.stringify(TITLE)} }, sleeping: false }]; m.updateInboxTab(); return true; })()`);
        await inboxFolder('needs', '#group-table-view .dt-table tbody tr');
        await ev(`[...document.querySelectorAll('#group-table-view .dt-table tbody tr .dt-link')].find(b => b.textContent === ${JSON.stringify(TITLE)}).click(); true`);
        await waitFor(`location.pathname === ${JSON.stringify(`/inbox/goals/${B}/${G}`)} && document.querySelector('#inbox-page #goals-detail-title')?.textContent === ${JSON.stringify(TITLE)}`, 'Needs you: the goal opens in the Inbox (#8861)', 15000);
        assert.equal(await ev(`location.pathname.startsWith('/board/')`), false, 'Needs you: not the board page');
        console.log('   ✓');

        console.log('3. The Inbox task page\'s Goal button');
        await home();
        await inboxFolder('tasks', '#group-table-view .dt-table tbody tr .dt-primary');
        await ev(`document.querySelector('#group-table-view .dt-table tbody tr .dt-primary').click(); true`);
        await waitFor(`!![...document.querySelectorAll('#inbox-page .goals-facts dt')].find(x=>x.textContent==='Goal')?.nextElementSibling.querySelector('button')`, 'the task page with its Goal button', 15000);
        await ev(`[...document.querySelectorAll('#inbox-page .goals-facts dt')].find(x=>x.textContent==='Goal')?.nextElementSibling.querySelector('button').click(); true`);
        // since #8861 the goal opens inside the Inbox, at its own address (the quiet team link is the way out)
        await waitFor(`location.pathname === ${JSON.stringify(`/inbox/goals/${B}/${G}`)} && document.querySelector('#inbox-page #goals-detail-title')?.textContent === ${JSON.stringify(TITLE)}`, 'Inbox task page: the goal opens in the Inbox', 15000);
        assert.equal(await ev(`location.pathname.startsWith('/board/')`), false, 'Inbox task page: not the board page');
        console.log('   ✓');

        console.log('4. A task\'s Goal line (task-goal-open)');
        await home();
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.selectedTeam = ${JSON.stringify(B)}; const b = document.createElement('button'); b.id = 'zz-goal-open'; b.setAttribute('data-on-click', 'task-goal-open'); b.setAttribute('data-goal-id', ${JSON.stringify(String(G))}); b.textContent = 'Goal'; document.body.append(b); b.click(); b.remove(); return true; })()`);
        await landed('task-goal-open');
        console.log('   ✓');
        console.log('PASS goal links: Inbox Goals opens /inbox/goals/<team>/<id>; its team link and other goal links open /team/<team>/goals/<id>');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
