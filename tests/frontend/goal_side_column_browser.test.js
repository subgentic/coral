// A goal's page puts its tasks in a column beside it (#7665, UI/UX's mock): the goal's details are the main pane, its tasks a 340 px column at the right (search, Open then Done, a state chip and who on each row), a task picked
// from the column is the task page (#7644) in the main pane with a back link "Goal: <title>" and the column beside it; "Done by <name>" names who built a done task (worked_by: the author of a reviewed task, not the
// orchestrator it was handed to). On a phone the goal, its task list and a task are three screens, 44 px targets. Real board on the isolated dev server (removed again). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const B = 'gsc-' + Date.now().toString(36);
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && require('node:path').join(process.env.RUNNER_TEMP, 'out', 'shots')); if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); new Promise(r => setTimeout(r, 350))`); /* sleep-ok: a screenshot waits out transitions */ fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const lightShot = async name => { await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(sc => { sc.applyTheme('light'); return true; })`); await new Promise(r => setTimeout(r, 300)); /* sleep-ok: the theme repaints, there is no event for it */ await shot(name); await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(sc => { sc.applyTheme('dark'); return true; })`); }; // the same scene in the light theme (#8784)
    const rows = () => ev(`[...document.querySelectorAll('.goal-side .dt-table tbody tr')].map(r => ({ title: r.querySelector('.dt-title-cell').textContent, hover: r.querySelector('.dt-title-cell').title, who: (() => { const c = r.querySelector('td[data-key="who"]'), i = c.querySelector('[role=img]'); return i ? i.getAttribute('aria-label') : c.textContent.trim(); })(), circles: r.querySelectorAll('td[data-key="who"] .dt-avatar').length, chip: r.querySelector('.goal-chip').textContent, current: r.getAttribute('aria-current') }))`);
    const openGoal = async (goal, tab = 'goals') => { await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: ${JSON.stringify(tab)}, item: ${goal} }); true`); await waitFor(`!!document.querySelector('.goal-split') && document.querySelectorAll('.dt-primary').length > 0 && document.querySelector('.goal-side').getClientRects().length + document.querySelector('.goal-main').getClientRects().length > 0`, 'the goal page', 15000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const [id, jt] of [['orch', 'Orchestrator'], ['dev', 'Developer'], ['rev', 'QA Engineer']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' })).status, 200);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Tasks and goals stay readable', outcome: 'A goal page shows its tasks in a column.', done_when: 'The operator approves it on screenshots.' }); assert.equal(g.status, 201, JSON.stringify(g));
        const goal = g.body.id;
        const mk = async (title, assigned) => { const r = await api('POST', `/api/board/${B}/tasks`, { title, body: 'Text of ' + title, created_by: 'orch', priority: 'medium', goal_id: goal, ...(assigned ? { assigned_to: assigned } : {}) }); assert.ok(r.status < 300, JSON.stringify(r)); return r.body.id || r.body.task.id; };
        const built = await mk('Build the column', 'dev'), second = await mk('Second open task'), third = await mk('Third open task');
        // a task the developer built and the orchestrator completed after a review: its assignee is the orchestrator, its worker the developer
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'dev', task_id: built })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/tasks/${built}/submit-review`, { subscriber_id: 'dev', reason: 'review pending', message: 'Built.', artifacts: [] })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/tasks/${built}/complete`, { subscriber_id: 'orch', message: 'Accepted.' })).status, 200);

        console.log('1. The goal page: its details, and its tasks in a column at the right');
        await openGoal(goal);
        const lay = await ev(`(() => { const m = document.querySelector('.goal-main').getBoundingClientRect(), s = document.querySelector('.goal-side').getBoundingClientRect(); return { sideRight: s.left >= m.right - 1, w: Math.round(s.width), title: document.getElementById('goals-detail-title').textContent, head: document.querySelector('.goal-side-head').textContent, groups: [...document.querySelectorAll('.goal-side-group')].map(h => h.textContent), table: !!document.querySelector('#team-panel-goals .team-table'), add: !!document.querySelector('.goal-main .goals-pinbar .goals-add-task'), label: document.querySelector('.goal-side').getAttribute('aria-label') }; })()`);
        check('the column is beside the goal, 340 px wide, with the goal in the main pane and no task table', lay.sideRight && lay.w === 340 && lay.title === 'Tasks and goals stay readable' && !lay.table && lay.add, JSON.stringify(lay));
        check('the header counts the tasks and the groups are Open then Done', /^Tasks\s*2 open, 1 done$/.test(lay.head) && JSON.stringify(lay.groups) === JSON.stringify(['Open 2', 'Done 1']), JSON.stringify([lay.head, lay.groups]));
        const rs = await rows();
        check('each row: the title without its number (it is the hover title, #8784), a state chip, and who', rs.length === 3 && rs[0].title === 'Second open task' && rs[0].hover === 'Task #' + second && rs[0].chip === 'Queued' && rs[0].who === 'Nobody yet', JSON.stringify(rs));
        check('Assigned to is the person as one circle, named "Done by dev" (its accessible name and hover text), not the words (#8492)', rs[2].circles === 1 && await ev(`(() => { const i = document.querySelector('.goal-side .dt-table tbody tr:last-child td[data-key="who"] [role=img]'); return !!i && i.title === 'Done by dev' && !i.querySelector('.dt-person-name'); })()`), JSON.stringify(rs[2]));
        check('a done task says who built it, not the orchestrator who completed it ("Done by dev")', rs[2].title === 'Build the column' && rs[2].hover === 'Task #' + built && rs[2].who === 'Done by dev' && rs[2].chip === 'Done', JSON.stringify(rs[2]));
        check('the title has a gap under its back link', await ev(`(() => { const b = document.querySelector('.goal-main .goals-back').getBoundingClientRect(), t = document.getElementById('goals-detail-title').getBoundingClientRect(); return t.top - b.bottom >= 8; })()`));
        const compactDesktop = await ev(`[...document.querySelectorAll('.goal-side .dt-row')].map(r => r.getBoundingClientRect().height)`);
        check('goal Tasks rows are at most 68px', compactDesktop.every(h => h > 0 && h <= 68), JSON.stringify(compactDesktop));
        await shot('goal-column-desktop'); await lightShot('goal-column-desktop-light');

        console.log('1b. The column is a right sidebar: flush right, the page height, resized like the dock');
        const flush = await ev(`(() => { const s = document.querySelector('.goal-side').getBoundingClientRect(), p = document.getElementById('team-page-scroll') || document.querySelector('.team-page-scroll'), pr = p.getBoundingClientRect(), g = document.querySelector('.goal-side-grip'); return { right: Math.round(pr.right - s.right), top: Math.round(s.top - pr.top), bottom: Math.round(pr.bottom - s.bottom), margin: getComputedStyle(document.querySelector('.goal-side')).margin, radius: getComputedStyle(document.querySelector('.goal-side')).borderRadius, grip: !!g && g.getAttribute('role') === 'separator', pageScrolls: p.scrollHeight > p.clientHeight + 1 }; })()`);
        check('the column touches the page area on the right, top and bottom, with no card margin or rounding', Math.abs(flush.right) <= 1 && Math.abs(flush.top) <= 1 && Math.abs(flush.bottom) <= 1 && flush.margin === '0px' && flush.radius === '0px' && flush.grip && !flush.pageScrolls, JSON.stringify(flush));
        const width = () => ev(`Math.round(document.querySelector('.goal-side').getBoundingClientRect().width)`);
        const drag = async (dx) => { const r = await ev(`(() => { const b = document.querySelector('.goal-side-grip').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 200) }; })()`); const Input = client.Input; await Input.dispatchMouseEvent({ type: 'mouseMoved', x: r.x, y: r.y }); await Input.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseMoved', x: r.x + dx, y: r.y, button: 'left' }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: r.x + dx, y: r.y, button: 'left', clickCount: 1 }); };
        await drag(-100);
        await waitFor(`Math.round(document.querySelector('.goal-side').getBoundingClientRect().width) === 440`, 'the column dragged 100 px wider', 5000);
        check('dragging the handle on its left edge widens it by the distance dragged, and the width is remembered', (await width()) === 440 && (await ev(`localStorage.getItem('coral-goal-side-width')`)) === '440');
        await drag(2000);
        check('it stops at the dock\'s minimum, 280 px', (await width()) === 280, String(await width()));
        await drag(-3000);
        const maxW = await width();
        check('and at the dock\'s maximum: the page beside it keeps 240 px', Math.abs(maxW - (await ev(`Math.round(document.querySelector('.goal-split').getBoundingClientRect().width) - 240`))) <= 1, String(maxW));
        await ev(`document.querySelector('.goal-side-grip').focus(); true`);
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
        check('the handle is a keyboard separator: Home goes to 280, Left widens by 24', (await width()) === 304, String(await width()));
        await ev(`document.querySelector('.goal-side-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
        check('a double click resets it to 340 and forgets the saved width', (await width()) === 340 && (await ev(`localStorage.getItem('coral-goal-side-width')`)) === null);
        await drag(-60);
        await openGoal(goal, 'goals'); // drawn again: the remembered width is applied again
        check('the width is remembered when the goal page is drawn again', (await width()) === 400, String(await width()));
        await ev(`localStorage.removeItem('coral-goal-side-width'); true`);
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'goals' }); true`); await openGoal(goal);
        const sep = await ev(`(() => { const g = document.querySelector('.goal-side-grip'), w = Math.round(document.querySelector('.goal-side').getBoundingClientRect().width); return { role: g.getAttribute('role'), name: g.getAttribute('aria-label'), now: g.getAttribute('aria-valuenow'), min: g.getAttribute('aria-valuemin'), max: g.getAttribute('aria-valuemax'), w, tab: g.tabIndex }; })()`);
        check('the handle is a separator named "Resize the task list" with its value, minimum and maximum, reachable by Tab', sep.role === 'separator' && sep.name === 'Resize the task list' && sep.now === String(sep.w) && sep.min === '280' && Number(sep.max) > 280 && sep.tab === 0, JSON.stringify(sep));
        const idle = await ev(`getComputedStyle(document.querySelector('.goal-side-grip'), '::before').backgroundColor`);
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8, windowsVirtualKeyCode: 16 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }); // the last input was the keyboard, so a focus shows as :focus-visible
        await ev(`document.querySelector('.goal-side-grip').focus(); true`);
        await waitFor(`getComputedStyle(document.querySelector('.goal-side-grip'), '::before').backgroundColor !== 'rgba(0, 0, 0, 0)'`, 'the focus line to be drawn (its colour fades in over 150 ms)', { timeout: 3000 });
        const focused = await ev(`({ onGrip: document.activeElement.classList.contains('goal-side-grip'), color: getComputedStyle(document.querySelector('.goal-side-grip'), '::before').backgroundColor, width: getComputedStyle(document.querySelector('.goal-side-grip'), '::before').width, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() })`);
        check('a clear 2 px line in the accent colour shows on keyboard focus, and none at rest', idle === 'rgba(0, 0, 0, 0)' && focused.onGrip && focused.width === '2px' && focused.color !== 'rgba(0, 0, 0, 0)', JSON.stringify([idle, focused]));
        await shot('goal-column-handle-focus');
        await ev(`document.activeElement.blur(); true`);
        await shot('goal-column-flush-desktop');

        console.log('2. Search');
        await ev(`(() => { const s = document.querySelector('.goal-side-search'); s.value = 'third'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        check('the search narrows the column', JSON.stringify((await rows()).map(r => r.title)) === JSON.stringify(['Third open task']));
        await ev(`(() => { const s = document.querySelector('.goal-side-search'); s.value = 'zzz'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        check('and says when nothing matches', /No task matches/.test(await ev(`document.querySelector('.goal-side-list').textContent`)));
        await ev(`(() => { const s = document.querySelector('.goal-side-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

        console.log('3. A task picked from the column is its page in the main pane');
        await ev(`document.querySelector('.dt-primary[data-task-id="${second}"]').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-item #team-task-title') && !!document.querySelector('#team-panel-item .goals-pinbar .btn')`, 'the canonical task page', 12000);
        check('the goal row opens the task URL under the Tasks tab', await ev(`location.pathname === '/team/${B}/tasks/${second}' && document.querySelector('#team-tab-tasks').getAttribute('aria-selected') === 'true' && document.activeElement.id === 'team-task-title'`));
        await shot('goal-column-task-desktop');
        await ev(`[...document.querySelectorAll('#team-panel-item .goals-pinbar .btn')].find(b => b.textContent === 'Complete').click(); true`);
        await waitFor(`!!document.getElementById('task-complete-message')`, 'the completion form');
        await ev(`document.getElementById('task-complete-message').value = 'Done from the task page'; [...document.querySelectorAll('#team-panel-item .goals-pinbar .btn')].find(b => b.textContent === 'Complete').click(); true`);
        await waitFor(`!document.getElementById('task-complete-message')`, 'completion saved');
        await ev(`document.querySelector('#team-panel-item .goals-back').click(); true`);
        // A refresh may remove the now-completed row from Open after Back focuses it.
        // The list then restores focus to its selected filter; both are valid return targets.
        await waitFor(`location.pathname === '/team/${B}/tasks' && !!document.activeElement?.getClientRects().length && (document.activeElement?.dataset.taskId === '${second}' || document.activeElement?.id === 'team-tab-tasks' || document.activeElement?.matches('#team-panel-tasks .goals-chip[aria-pressed="true"]'))`, 'back at Tasks with row, tab or selected-filter focus', 8000);
        await openGoal(goal);
        await waitFor(`document.querySelector('.goal-side-head').textContent.replace(/\\s+/g, ' ').includes('1 open, 2 done')`, 'goal reflects the completed task', 15000);
        // The goal rollup arrives before its separate task-list request. Wait for the
        // column's existing busy state to clear before checking its refreshed groups.
        await waitFor(`!!document.querySelector('.goal-side-list') && document.querySelector('.goal-side-list').getAttribute('aria-busy') !== 'true'`, 'goal task rows refreshed after completion', 15000);
        check('the goal column reflects completion on the shared page', JSON.stringify(await ev(`[...document.querySelectorAll('.goal-side-group')].map(h => h.textContent)`)) === JSON.stringify(['Open 1', 'Done 2']), JSON.stringify(await rows()));
        check('the completed task row now says Done', (await rows()).some(r => r.title === 'Second open task' && r.chip === 'Done'));

        console.log('4. A phone: the goal, its task list and a task are three screens');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await openGoal(goal);
        const vis = sel => ev(`!!document.querySelector(${JSON.stringify(sel)}) && document.querySelector(${JSON.stringify(sel)}).getClientRects().length > 0`);
        check('the goal is the first screen: its details and a "Tasks, 1 open, 2 done" button, no column', await vis('.goal-main #goals-detail-title') && !(await vis('.goal-side')) && /Tasks, 1 open, 2 done/.test(await ev(`document.querySelector('.goal-tasks-open').getAttribute('aria-label')`)));
        check('the button is a 44 px target', await ev(`document.querySelector('.goal-tasks-open').getBoundingClientRect().height >= 43.5`));
        await shot('goal-phone-goal');
        await ev(`document.querySelector('.goal-tasks-open').click(); true`);
        await waitFor(`document.querySelector('.goal-side').getClientRects().length > 0`, 'the list screen');
        await waitFor(`!!document.querySelector('.goal-side .dt-box.dt-folded')`, 'the column folds', 5000);
        check('the list is the next screen: the column, a way back to the goal, no main pane; rows are 44 px', await vis('.goal-side-back') && !(await vis('.goal-main')) && await ev(`[...document.querySelectorAll('.goal-side .dt-table tbody tr')].every(b => b.getBoundingClientRect().height >= 43.5)`));
        check('the list screen runs the page\'s whole width', await ev(`(() => { const s = document.querySelector('.goal-side').getBoundingClientRect(), p = document.querySelector('.goal-split').getBoundingClientRect(); return Math.abs(s.width - p.width) <= 1; })()`));
        const compactPhone = await ev(`[...document.querySelectorAll('.goal-side .dt-row')].map(r => r.getBoundingClientRect().height)`);
        check('goal Tasks rows are at most 68px', compactPhone.every(h => h > 0 && h <= 68), JSON.stringify(compactPhone));
        await shot('goal-phone-list'); await lightShot('goal-phone-list-light');
        await ev(`document.querySelector('.dt-primary[data-task-id="${third}"]').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-item #team-task-title') && document.querySelector('#team-panel-item').getClientRects().length > 0`, 'the canonical task screen');
        check('a phone task opens the same Tasks page and URL', await ev(`location.pathname === '/team/${B}/tasks/${third}' && document.querySelector('#team-tab-tasks').getAttribute('aria-selected') === 'true'`));
        await shot('goal-phone-task');
        await ev(`document.querySelector('#team-panel-item .goals-back').click(); true`);
        await waitFor(`location.pathname === '/team/${B}/tasks'`, 'back on the team task list');
        await openGoal(goal);
        check('the goal again, nothing wider than the screen', await ev(`document.documentElement.scrollWidth - innerWidth <= 0`));
    } finally { await api('DELETE', `/api/board/${B}`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
