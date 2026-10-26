// A waiting agent or task says which goal it serves (#7302, the Operator: "the task/agent that are waiting can let me know which goal it is a part of"): in the Inbox's Needs you a row shows a quiet link
// "Goal: <title>" under it when the live row carries a goal (live rows: goal {id, title, board}, #7301), and nothing when it has none; the link opens the goal on its team page's Goals tab. In the Tasks panel
// an opened task shows the same link when the row carries goal_id and goal_title (goal_id and goal_title come from the route's own answer, #7345). Real board over the API for the goal.
// Drives Chrome over CDP against the isolated dev server (its rows are removed again).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'inbox-goal-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'orch-s' })).status, 200);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Ship the new installer' }); assert.equal(g.status, 201, JSON.stringify(g));
        const t1 = await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'orch', title: 'Sign the installer', priority: 'high', assigned_to: 'Operator', goal_id: g.json.id }); assert.equal(t1.status, 201, JSON.stringify(t1));
        const t2 = await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'orch', title: 'Pick the icon', priority: 'low', assigned_to: 'Operator' }); assert.equal(t2.status, 201);
        await ev(`(() => { const waiting = ['fe-id', 'qa-id']; const entry = window.__m.entry.bind(window.__m);
            window.__m.entry = a => ({ ...entry(a), board_project: ${JSON.stringify(B)}, board_job_title: 'Dev', waiting_for_input: waiting.includes(a.session_id), waiting_kind: waiting.includes(a.session_id) ? 'permission' : null, goal: a.session_id === 'fe-id' ? { id: ${g.json.id}, title: 'Ship the new installer', board: ${JSON.stringify(B)} } : null });
            window.__m.add('fe', 'F', 4, { sleeping: false, session_id: 'fe-id' }); window.__m.add('qa', 'Q', 4, { sleeping: false, session_id: 'qa-id' }); return true; })()`);
        await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 2`, 'two agents in the live list', 8000);
        await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); document.getElementById('nav-tab-hub-inbox').click(); true`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'two agents waiting', 10000);

        console.log('1. Needs you: the agent with a goal has a quiet "Goal: <title>" link under its row, the other has none');
        const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(tr => ({ name: tr.querySelector('.dt-primary').textContent, goal: (tr.querySelector('.dt-link') || {}).textContent || '', aria: (tr.querySelector('.dt-link') || {}).ariaLabel || '' }))`);
        assert.deepEqual(rows.map(r => [r.name, r.goal]).sort(), [['fe', 'Ship the new installer'], ['qa', '']]);
        assert.equal(rows.find(r => r.name === 'fe').aria, 'Goal: Ship the new installer', 'the cell button says which goal it is');
        assert.equal(await ev(`document.querySelectorAll('#group-table-view .dt-link').length`), 1);

        await shot('inbox-needs-goal');
        console.log('2. the link opens the goal on its team page\'s Goals tab (#8048)');
        await ev(`document.querySelector('#group-table-view .dt-link').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-goals .goals-detail-title') && document.querySelector('#team-panel-goals .goals-detail-title').textContent === 'Ship the new installer' && location.pathname.startsWith('/team/')`, 'the goal to open on the team page', 12000);
        await waitFor(`document.activeElement.id === 'goals-detail-title'`, 'the focus on the goal\'s heading (a person chose it)', 6000);

        console.log('3. an opened task in the Inbox shows the same link when its row carries a goal, and nothing when it has none');
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')); true`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'two tasks', 10000);
        const links = [];
        for (const title of ['Pick the icon', 'Sign the installer']) { // the one with a goal last: its page stays open for the look below
            await ev(`[...document.querySelectorAll('#group-table-view .dt-primary')].find(b => b.textContent === ${JSON.stringify(title)}).click(); true`);
            await waitFor(`!!document.querySelector('#inbox-page .ibx-reply-label')`, `${title} opened`, 8000);
            links.push(await ev(`({ t: document.querySelector('#team-task-title').textContent.replace(/^#\\d+ /, ''), g: ([...document.querySelectorAll('#inbox-page .goals-facts dt')].find(x => x.textContent === 'Goal')?.nextElementSibling.querySelector('button') || {}).textContent || '' })`));
            if (title === 'Sign the installer') break;
            await ev(`document.querySelector('#inbox-page .goals-back').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, 'back at the table', 8000);
        }
        assert.deepEqual(links.sort((a, b) => a.t.localeCompare(b.t)), [{ t: 'Pick the icon', g: '' }, { t: 'Sign the installer', g: 'Ship the new installer' }]);
        assert.equal(await ev(`location.pathname`), `/inbox/tasks/${B}/${t1.json.id}`, 'Inbox task row stays in the Inbox');
        await ev(`[...document.querySelectorAll('#inbox-page .goals-facts dt')].find(x => x.textContent === 'Goal').nextElementSibling.querySelector('button').click(); true`);
        await waitFor(`document.querySelector('#team-panel-goals .goals-detail-title')?.textContent === 'Ship the new installer' && location.pathname.includes('/goals/')`, 'task Goal link opens the goal', 10000);
        await shot('inbox-task-goal');
        console.log('PASS the goal a waiting agent or task serves');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
