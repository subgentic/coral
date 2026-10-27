// The Create task dialog and the task page for the keyboard, a screen reader and both themes (#5814, #7644): a refusal in the Create dialog is spoken once (the footer's status line; the field's own error is its description, not an alert, #8431) and marks the
// title; "+ Add dependency" and a dependency tag's × are buttons (they were links with no href: not reachable by Tab, and the × had no name); the task's page is named by its task and
// opens in the shared preview with focus on its close control, and Escape gives focus back to the row; and the real light theme holds 4.5:1 in the Create dialog and on the task page in its three states (the page, Edit, Complete).
// Focus goes to the title on open and back to what opened the dialog on Escape. Real board over the API. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const { removeBoards } = require('./helpers/board_cleanup');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const B = 'a11y-task-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    const key = async (k, code, vk, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: k, code, windowsVirtualKeyCode: vk, modifiers }); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = id => ev(`getComputedStyle(document.getElementById('${id}')).display !== 'none'`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        for (const [id, t] of [['Boss', 'Orchestrator'], ['dev-1', 'Developer']]) assert.equal(await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: t, session_name: id + '-s' }), 200);
        assert.equal(await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'Boss', title: 'Ship the queue', body: 'Do it.', priority: 'high', assignee: 'dev-1' }), 201);
        assert.equal(await api('POST', `/api/board/${B}/tasks`, { subscriber_id: 'Boss', title: 'Write the docs', priority: 'low' }), 201);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await openBoardTasksTab({ ev, waitFor }, B); // the board's tasks are an agent's Tasks tab (#7457)
        await waitFor(`document.querySelectorAll('#agentic-panel-tasks .board-task-item').length >= 2 && document.getElementById('agentic-panel-tasks').getBoundingClientRect().width > 50`, 'the tasks', 15000);

        console.log('1. Create task: focus, a spoken refusal, a keyboard-reachable dependency picker');
        await ev(`document.querySelector('#board-task-bar .btn-create-task').focus(); document.querySelector('#board-task-bar .btn-create-task').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('create-task-modal')).display !== 'none'`, 'the dialog', 8000);
        assert.equal(await ev(`document.activeElement.id`), 'create-task-title', 'focus goes to the title on open');
        assert.equal(await ev(`document.getElementById('create-task-title').getAttribute('aria-required')`), 'true');
        await ev(`document.getElementById('create-task-submit').click(); true`);
        const err = await ev(`(() => { const t = document.getElementById('create-task-title'); const e = t.closest('.sv-row').querySelector('.sv-error'); return { text: e.textContent, role: e.getAttribute('role'), shown: getComputedStyle(e).display !== 'none', invalid: t.getAttribute('aria-invalid'), described: (t.getAttribute('aria-describedby') || '').split(' ').includes(e.id), status: document.querySelector('#create-task-footer .sv-status').textContent, focus: document.activeElement.id }; })()`);
        assert.deepEqual(err, { text: 'Title is required', role: null, shown: true, invalid: 'true', described: true, status: 'Title is required', focus: 'create-task-title' }, 'the refusal is the title\'s description and the status line beside the buttons says it (no second alert)');
        await shot('create-error-dark');
        await ev(`const t = document.getElementById('create-task-title'); t.value = 'x'; t.dispatchEvent(new Event('input', { bubbles: true })); true`);
        assert.equal(await ev(`document.querySelector('#create-task-flow').open`), false, 'optional workflow fields start folded');
        assert.equal(await ev(`document.getElementById('create-task-draft').checkVisibility()`), true, 'draft visibility remains a primary choice');
        await ev(`document.querySelector('#create-task-flow > summary').focus();true`);
        await key(' ', 'Space', 32);
        assert.equal(await ev(`document.getElementById('create-task-workflow').checkVisibility()`), true, 'Space opens the workflow fields');
        const add = await ev(`(() => { const b = document.querySelector('#create-task-modal .dep-picker-add-link'); return { tag: b && b.tagName, type: b && b.type, expanded: b && b.getAttribute('aria-expanded'), controls: b && b.getAttribute('aria-controls'), tabbable: !!b && b.tabIndex >= 0 }; })()`);
        assert.deepEqual(add, { tag: 'BUTTON', type: 'button', expanded: 'false', controls: add.controls, tabbable: true }, '"+ Add dependency" is a button');
        await ev(`document.querySelector('#create-task-modal .dep-picker-add-link').focus(); true`);
        await key(' ', 'Space', 32);
        assert.equal(await ev(`document.querySelector('#create-task-modal .dep-picker-add-link').getAttribute('aria-expanded')`), 'true', 'Space opens the list');
        await ev(`document.querySelector('#create-task-modal .dep-picker-item input').click(); true`);
        const tag = await ev(`(() => { const b = document.querySelector('#create-task-modal .dep-tag .dep-tag-remove'); return b && { tag: b.tagName, label: b.getAttribute('aria-label') }; })()`);
        assert.ok(tag && tag.tag === 'BUTTON' && /^Remove dependency #\d+/.test(tag.label), 'a dependency tag\'s x is a named button: ' + JSON.stringify(tag));
        // A rejected workflow must not remain concealed after the user folds it.
        await ev(`(async () => { const d=document.querySelector('#create-task-flow'); d.open=false;
            const original=window.fetch; window.fetch=async (u,o)=>String(u).endsWith('/tasks') && o?.method==='POST' ? new Response(JSON.stringify({error:'Required upstream artifact is missing'}),{status:400,headers:{'content-type':'application/json'}}) : original(u,o);
            try { document.getElementById('create-task-title').value = 'x'; document.getElementById('create-task-submit').click(); for (let i = 0; i < 60 && !d.open; i++) await new Promise(r => setTimeout(r, 50)); } finally { window.fetch=original; } })()`);
        assert.equal(await ev(`document.querySelector('#create-task-flow').open`), true, 'a server refusal reveals workflow fields');
        await key('Escape', 'Escape', 27);
        await waitFor(`getComputedStyle(document.getElementById('create-task-modal')).display === 'none'`, 'Escape closes it', 4000);
        assert.ok(await ev(`document.activeElement.classList.contains('btn-create-task')`), 'focus goes back to + Task');

        await ev(`(async()=>{await window.showCreateTaskModal({blocked_by:[{task_id:(await import((window.__coralStatic||'/static/')+'state.js')).state.currentBoardTasks[0].id,condition:'failure',required_artifacts:['build']}],workflow:{name:'Release'}});})()`);
        assert.ok(await ev(`document.querySelector('#create-task-flow').open && document.getElementById('create-task-condition').value==='failure' && document.getElementById('create-task-workflow').value==='Release' && document.querySelector('#create-task-deps input:checked') && document.getElementById('create-task-inputs').value==='build'`), 'preset prerequisites, condition and workflow are visible');
        await key('Escape', 'Escape', 27);
        await ev(`window.showCreateTaskModal({condition:'termination'})`);
        assert.ok(await ev(`document.querySelector('#create-task-flow').open && document.getElementById('create-task-condition').value==='termination'`), 'a preset condition alone is visible');
        await key('Escape', 'Escape', 27);
        await ev(`window.showCreateTaskModal()`);
        assert.equal(await ev(`document.querySelector('#create-task-flow').open`), false, 'fresh tasks reset to folded');
        await key('Escape', 'Escape', 27);

        console.log('2. the task preview is named by its task and gives the focus back');
        await ev(`document.querySelector('#agentic-panel-tasks .board-task-open').focus(); document.querySelector('#agentic-panel-tasks .board-task-open').click(); true`);
        await waitFor(`!!document.querySelector('#preview-pane #team-task-title') && document.activeElement === document.querySelector('#preview-pane .preview-tab.active .preview-tab-close') && getComputedStyle(document.getElementById('task-detail-modal')).display === 'none'`, 'the task preview (and no dialog)', 12000);
        const nm = await ev(`({ region: document.querySelector('#preview-pane .team-task-page').parentElement.getAttribute('aria-label'), title: document.querySelector('#preview-pane #team-task-title').textContent, focus: document.activeElement.classList.contains('preview-tab-close') })`);
        assert.ok(/^Task \d+$/.test(nm.region) && /^#\d+ (Ship the queue|Write the docs)$/.test(nm.title) && nm.focus, 'the preview content is named by its task and the close control has focus: ' + JSON.stringify(nm));
        await key('Escape', 'Escape', 27);
        await waitFor(`!document.querySelector('#preview-pane #team-task-title') && document.activeElement?.classList.contains('dt-primary') && !!document.activeElement.dataset.taskId`, 'the focus back on the task\'s row', 8000);

        console.log('3. both themes hold 4.5:1 in the dialog and on the page');
        await installAudit(ev);
        const ids = await ev(`fetch('/api/board/${B}/tasks').then(r => r.json()).then(j => j.tasks.map(t => t.id))`);
        for (const theme of ['dark', 'light']) {
            await setTheme(ev, theme);
            await ev(`window.exitTeamPage && window.exitTeamPage({ force: true }); window.selectLiveSession('bt-agent', 'claude', 'bt-agent-id', 'local'); true`);
            await waitFor(`!!document.querySelector('#board-task-bar .btn-create-task') && document.querySelector('#board-task-bar .btn-create-task').getClientRects().length > 0`, 'the Tasks tab again', 8000);
            await ev(`document.querySelector('#board-task-bar .btn-create-task').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('create-task-modal')).display !== 'none'`, 'create', 5000);
            const c = await auditRegion(ev, ['#create-task-modal']); await shot(`create-${theme}`);
            await ev(`document.querySelector('#create-task-modal .modal-close-btn').click(); true`);
            assert.ok(c.checked > 0 && !c.fails.length, `${theme}: the Create task dialog holds 4.5:1: ` + JSON.stringify(c.fails).slice(0, 400));
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks', item: ${ids[0]} }); true`);
            await waitFor(`!!document.querySelector('#team-panel-item #team-task-title') && document.querySelector('#team-task-title').getClientRects().length > 0 && !!document.querySelector('#team-panel-item .goals-pinbar .btn')`, 'the page (drawn, not the last one left behind a hidden view)', 12000);
            const d = await auditRegion(ev, ['#team-panel-item']); await shot(`page-${theme}`);
            assert.ok(d.checked > 0 && !d.fails.length, `${theme}: the task page holds 4.5:1: ` + JSON.stringify(d.fails).slice(0, 400));
            const bar = text => ev(`[...document.querySelectorAll('#team-panel-item .goals-pinbar .btn')].find(b => b.textContent === ${JSON.stringify(text)}).click(); true`);
            await bar('Edit'); await waitFor(`!!document.getElementById('task-edit-title')`, 'the form', 8000);
            const e = await auditRegion(ev, ['#team-panel-item']); await shot(`edit-${theme}`);
            assert.ok(e.checked > 0 && !e.fails.length, `${theme}: the edit form holds 4.5:1: ` + JSON.stringify(e.fails).slice(0, 400));
            await bar('Cancel'); await waitFor(`!document.getElementById('task-edit-title')`, 'back on the page', 8000);
            await bar('Complete'); await waitFor(`!!document.getElementById('task-complete-message')`, 'the completion form', 8000);
            const k = await auditRegion(ev, ['#team-panel-item']); await shot(`complete-${theme}`);
            assert.ok(k.checked > 0 && !k.fails.length, `${theme}: the completion form holds 4.5:1: ` + JSON.stringify(k.fails).slice(0, 400));
        }
        console.log('   ✓');
    } finally { await removeBoards(ev, [B]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
