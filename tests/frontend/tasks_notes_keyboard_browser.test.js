// The side panel's Tasks list and Notes by keyboard (#4026 follow-up): a task row opens its page and a column heading sorts on
// Enter or Space (both were mouse-only), and the rendered notes open for editing on Enter. Tasks come from the page state; run
// against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const press = async (k, code, vk) => { const base = { key: k, code, windowsVirtualKeyCode: vk }; await Input.dispatchKeyEvent({ type: 'keyDown', ...base, ...(k === 'Enter' ? { text: '\r' } : k === ' ' ? { text: ' ' } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', ...base }); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__m.add('task-bot', 'A', 3, { sleeping: false }); true`);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the first live list renders from several answers; no single completion event
        await ev(`window.selectLiveSession('task-bot', 'claude', 'task-bot-id', 'local'); true`);
        await waitFor(`!!document.getElementById('board-task-list')`, 'the tasks panel', 8000);
        await ev(`window.switchAgenticTab('tasks', 'top'); true`);
        await new Promise(r => setTimeout(r, 1500)); // sleep-ok: selecting the agent starts task loads whose late answers would redraw the list; no single completion event
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const t = await import(${S} + 'tasks.js'); t.stopBoardTaskPoll();
            state.currentBoardTasks = [{ id: 11, title: 'Write the keyboard test', status: 'pending', priority: 'high', created_at: '2026-10-01T10:00:00Z', assigned_to: 'Backend' },
                                       { id: 12, title: 'Fix the focus ring', status: 'pending', priority: 'low', created_at: '2026-10-02T10:00:00Z', assigned_to: 'QA' }];
            document.getElementById('board-tasks-section').style.display = '';
            t.renderBoardTaskList(); return true; })()`);
        await waitFor(`document.querySelectorAll('#board-task-list [data-on-click="task-open"]').length === 2`, 'two task rows', 5000);

        await ev(`document.getElementById('agentic-state').style.width = '1000px'; true`);
        await waitFor(`!document.querySelector('#board-task-list .dt-box').classList.contains('dt-folded')`, 'wide table headers');
        console.log('1. Tasks: rows and headings');
        const kinds = await ev(`[...document.querySelectorAll('#board-task-list .dt-sort')].map(e => ({ tab: e.tabIndex, role: e.getAttribute('role') }))`);
        assert.ok(kinds.length >= 1 && kinds.every(k => k.tab === 0 && k.role === null), 'the headings are focusable buttons: ' + JSON.stringify(kinds));
        // a task row is neither (#5813): its one keyboard control is the native Open button, named by the task and its status
        const rowKinds = await ev(`[...document.querySelectorAll('#board-task-list [data-on-click="task-open"]')].map(e => ({ tab: e.tabIndex, role: e.getAttribute('role'), open: e.querySelector('button.board-task-open')?.getAttribute('aria-label') || '' }))`);
        assert.ok(rowKinds.length === 2 && rowKinds.every(k => k.tab === -1 && k.role === 'row' && /^Open task: .+, .+$/.test(k.open)), 'rows are not buttons; each holds a named native Open button: ' + JSON.stringify(rowKinds));
        const sortLabel = () => ev(`document.querySelector('#board-task-list .dt-sort[data-key="task"]').textContent`);
        assert.equal((await sortLabel()).includes('↑') || (await sortLabel()).includes('↓'), false, 'not explicitly sorted by task yet');
        for (const [k, code, vk] of [['Enter', 'Enter', 13], [' ', 'Space', 32]]) {
            await ev(`document.querySelector('#board-task-list .dt-sort[data-key="task"]').focus(); true`);
            const before = await sortLabel();
            await press(k, code, vk);
            await waitFor(`document.querySelector('#board-task-list .dt-sort[data-key="task"]').textContent !== ${JSON.stringify(before)}`, `${JSON.stringify(k)} sorts by the heading`, 4000);
        }
        // Exercise the shared preview; these list fixtures also supply its task read.
        await ev(`(() => { const real = window.fetch; window.fetch = (u, o) => {
            const match = String(u).match(/\\/api\\/board\\/task-bot\\/tasks\\/(11|12)(?:[?]|$)/);
            if (match) return Promise.resolve(new Response(JSON.stringify(window.__qaState.currentBoardTasks.find(t => t.id === Number(match[1]))), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            return real(u, o);
        }; document.querySelector('#board-task-list .board-task-open').focus(); return true; })()`);
        const title = await ev(`document.activeElement.textContent`);
        await press('Enter', 'Enter', 13);
        await waitFor(`document.querySelector('#preview-pane #team-task-title')?.textContent.includes(${JSON.stringify(title)})`, 'the task opens in preview on Enter', 5000);
        assert.equal(await ev(`document.querySelectorAll('#preview-pane .preview-tab').length`), 1, 'one task preview opens');
        assert.equal(await ev(`getComputedStyle(document.getElementById('task-detail-modal')).display`), 'none', 'and no dialog');
        await ev(`document.querySelector('#preview-pane .preview-tab.active .preview-tab-close').click(); true`);
        console.log('   ✓ Enter opens a task preview, Enter and Space sort by a heading');

        console.log('2. Notes');
        await ev(`window.switchAgenticTab('notes', 'top'); true`);
        const r = await ev(`(() => { const e = document.querySelector('#note-md-rendered .note-add'); return { tag: e.tagName, tab: e.tabIndex, label: e.getAttribute('aria-label') }; })()`);
        assert.deepEqual(r, { tag: 'BUTTON', tab: 0, label: 'Add a note' }, 'with no note, the way to write one is a named, focusable button');
        await ev(`document.querySelector('#note-md-rendered .note-add').focus(); true`);
        await press('Enter', 'Enter', 13);
        await waitFor(`document.activeElement === document.getElementById('note-md-editor')`, 'Enter starts editing and focus moves to the editor', 4000);
        console.log('   ✓ Enter on Add notes starts editing');
        console.log('\nPASS tasks and notes by keyboard');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
