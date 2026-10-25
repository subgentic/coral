// A waiting agent or task says which goal it serves (#7302, the Operator: "the task/agent that are waiting can let me know which goal it is a part of"): in the Inbox's Needs you a row shows a quiet link
// "Goal: <title>" under it when the live row carries a goal (live rows: goal {id, title, board}, #7301), and nothing when it has none; the link opens the goal on its board's Goals face. In the Tasks panel
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
        await waitFor(`document.querySelectorAll('#inbox-needs-list .inbox-needs-item').length === 2`, 'two agents waiting', 10000);

        console.log('1. Needs you: the agent with a goal has a quiet "Goal: <title>" link under its row, the other has none');
        const rows = await ev(`[...document.querySelectorAll('#inbox-needs-list li')].map(li => ({ name: li.querySelector('.inbox-needs-name').textContent, goal: (li.querySelector('.inbox-needs-goal') || {}).textContent || '', inside: !!li.querySelector('.inbox-needs-item .inbox-needs-goal') }))`);
        assert.deepEqual(rows.map(r => [r.name, r.goal]).sort(), [['fe', 'Goal: Ship the new installer'], ['qa', '']]);
        assert.equal(rows.some(r => r.inside), false, 'the link is not inside the row\'s button (a control in a control)');
        assert.equal(await ev(`document.querySelectorAll('#inbox-needs-list .inbox-needs-goal').length`), 1);
        const tuck = await ev(`(() => { const g = document.querySelector('#inbox-needs-list .inbox-needs-goal'), c = g.parentElement.querySelector('.inbox-needs-item'), gr = g.getBoundingClientRect(), cr = c.getBoundingClientRect(); return { gap: Math.round(gr.top - cr.bottom), left: Math.round(gr.left - cr.left), width: Math.round(gr.width - cr.width), square: getComputedStyle(c).borderBottomLeftRadius, round: getComputedStyle(g).borderBottomLeftRadius }; })()`);
        assert.ok(tuck.gap >= -1 && tuck.gap <= 0 && tuck.left === 0 && tuck.width === 0 && tuck.square === '0px' && tuck.round !== '0px', 'the Goal link is the card\'s own footer, attached under its row: ' + JSON.stringify(tuck));

        await shot('inbox-needs-goal');
        console.log('2. the link opens the goal on its board\'s Goals face');
        await ev(`document.querySelector('#inbox-needs-list .inbox-needs-goal').click(); true`);
        await waitFor(`!!document.querySelector('#mb-goals .goals-detail-title') && document.querySelector('#mb-goals .goals-detail-title').textContent === 'Ship the new installer'`, 'the goal to open', 12000);
        assert.equal(await ev(`document.activeElement.id`), 'goals-detail', 'the focus is on the goal\'s detail');

        console.log('3. an opened task in the Inbox shows the same link when its row carries a goal, and nothing when it has none');
        await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
        await waitFor(`!!document.getElementById('inbox-tab-tasks') && document.getElementById('inbox-tab-tasks').getClientRects().length > 0`, 'the Inbox tabs', 8000);
        await ev(`document.getElementById('inbox-tab-tasks').click(); true`);
        await waitFor(`document.querySelectorAll('#inbox-panel-tasks .ibx-task').length === 2`, 'two tasks', 10000);
        for (const title of ['Sign the installer', 'Pick the icon']) {
            await ev(`[...document.querySelectorAll('#inbox-panel-tasks .ibx-task')].find(li => li.querySelector('.ibx-task-title').textContent === ${JSON.stringify(title)}).querySelector('.ibx-task-head').click(); true`);
            await waitFor(`!!document.querySelector('#inbox-panel-tasks .ibx-reply-label')`, `${title} opened`, 8000);
        }
        const links = await ev(`[...document.querySelectorAll('#inbox-panel-tasks .ibx-task')].map(li => ({ t: li.querySelector('.ibx-task-title').textContent, g: (li.querySelector('.ibx-goal') || {}).textContent || '' }))`);
        assert.deepEqual(links.sort((a, b) => a.t.localeCompare(b.t)), [{ t: 'Pick the icon', g: '' }, { t: 'Sign the installer', g: 'Goal: Ship the new installer' }]);
        const quiet = await ev(`(() => { const g = document.querySelector('#inbox-panel-tasks .ibx-goal'), o = g.parentElement.querySelector('.ibx-open:not(.ibx-goal)'), gs = getComputedStyle(g), gr = g.getBoundingClientRect(), or = o.getBoundingClientRect(); return { border: gs.borderTopWidth, underline: gs.textDecorationLine.includes('underline'), bg: gs.backgroundColor, gap: Math.round(gr.left - or.right), sameRow: Math.abs((gr.top + gr.bottom) / 2 - (or.top + or.bottom) / 2) < 14 }; })()`);
        assert.ok(quiet.border === '0px' && quiet.underline && quiet.bg === 'rgba(0, 0, 0, 0)' && quiet.gap >= 0 && quiet.gap <= 24 && quiet.sameRow, 'the task\'s Goal is the same quiet underlined link, beside Open the task: ' + JSON.stringify(quiet));
        await shot('inbox-task-goal');
        console.log('PASS the goal a waiting agent or task serves');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
