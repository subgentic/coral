// CSP stage 2, slice 4b (#3645): the board's tasks on delegated data-on-* actions, against real
// tasks on a real board. Each moved action still does what its inline handler did:
//  - the list: sort headers (only a known sort), Hide done, a row opens its task's page (#7644);
//  - the task page's bar: Edit then Cancel or Save, Cancel task through its question (Keep task, and
//    Cancel task), Complete through its form (and Back), Publish a draft, Nudge / Remind / Stop
//    reminders on a claimed task, a dependency link opening that task;
//  - the dependency picker: + Add dependency, a checkbox making a tag, the tag's × removing it;
//  - a task's coral:// artifact link opens the preview (only an artifact URI);
//  - a bad id does nothing, and no inline handler is left in the list or the dialog.
'use strict';

const { connect } = require('./agent_view_harness');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const BASE = require('./test_base').BASE;

const results = [];
const check = (label, ok, detail) => { results.push(!!ok); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
const BOARD = 'tasks-3645';

(async () => {
    const { client, PRELOAD, install } = await connect();
    const { Page, Runtime } = client;
    const ev = async expression => {
        const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
    };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
const { removeBoards } = require('./helpers/board_cleanup');
const { pinnedBarProbe } = require('./helpers/pinned_bar');
    const until = (expr, what, ms = 8000) => waitFor(expr, what, { timeout: ms });
    const MODS = `const tasks = await import((window.__coralStatic||'/static/')+'tasks.js'); const { state } = await import((window.__coralStatic||'/static/')+'state.js');`;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
            window.__req = [];
            const inner = window.fetch;
            window.fetch = (url, opts = {}) => {
                const u = String(url && url.url || url).replace(/^https?:\\/\\/[^/]+/, '');
                if (/\\/api\\/board\\/[^/]+\\/tasks\\/\\d+\\//.test(u) || /\\/api\\/board\\/[^/]+\\/tasks\\/\\d+$/.test(u)) window.__req.push((opts.method || 'GET').toUpperCase() + ' ' + u.split('?')[0]);
                return inner(url, opts);
            };
        })();` });
        const loaded = Page.loadEventFired();
        await Page.navigate({ url: BASE + '/' });
        await loaded;
        await install(); await coralReady();

        // Real tasks: a dependency, an open task blocked by it, a draft, and one a subscriber claims.
        const made = await ev(`(async () => {
            const call = async (method, path, body) => { const r = await fetch('/api/board/${BOARD}' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
                if (!r.ok) throw new Error(path + ': ' + r.status + ' ' + await r.text()); return r.json().catch(() => ({})); };
            await call('POST', '/subscribe', { subscriber_id: 'Worker', job_title: 'Worker', session_name: 'claude-worker-3645' });
            const dep = await call('POST', '/tasks', { title: 'the dependency', body: 'b', created_by: 'Operator' });
            const open = await call('POST', '/tasks', { title: 'open task', body: 'see coral://artifacts/${'a'.repeat(64)}', created_by: 'Operator', blocked_by: [dep.id] });
            const draft = await call('POST', '/tasks', { title: 'a draft', body: 'b', created_by: 'Operator', draft: true });
            const claimed = await call('POST', '/tasks', { title: 'claimed task', body: 'b', created_by: 'Operator', assigned_to: 'Worker' });
            await call('POST', '/tasks/claim', { subscriber_id: 'Worker' }).catch(() => null);
            return { dep: dep.id, open: open.id, draft: draft.id, claimed: claimed.id };
        })()`);
        const task = id => ev(`fetch('/api/board/${BOARD}/tasks/${id}').then(r => r.json()).then(j => j.task || j)`);
        await openBoardTasksTab({ ev, waitFor }, BOARD, 'actions-worker');
        await until(`document.querySelectorAll('#board-task-list [data-on-click="task-open"]').length >= 3`, 'the task list');
        const row = id => `document.querySelector('#board-task-list [data-on-click="task-open"][data-task-id="${id}"]')`;
        const dlgOpen = () => ev(`(() => { const m = document.getElementById('task-detail-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`);
        let root = '#preview-pane';
        const BAR = () => `[...document.querySelectorAll('${root} .goals-pinbar .btn')]`;

        // ── The list ───────────────────────────────────────────────────────
        const sorted = await ev(`(async () => { ${MODS}
            const order = () => [...document.querySelectorAll('#board-task-list [data-on-click="task-open"]')].map(r => r.dataset.taskId).join(',');
            const before = order();
            document.querySelector('#board-task-list .dt-sort[data-key="task"]').click();
            const a = order();
            document.querySelector('#board-task-list .dt-sort[data-key="task"]').click();
            const b = order();
            const bad = document.createElement('span'); bad.setAttribute('data-on-click', 'task-sort'); bad.dataset.sort = '__proto__'; document.body.appendChild(bad); bad.click(); bad.remove();
            return { before, a, b, after: order() };
        })()`);
        check('the ID header sorts the list and again reverses it; an unknown sort does nothing', sorted.a !== sorted.b && sorted.a.split(',').reverse().join(',') === sorted.b && sorted.after === sorted.b, JSON.stringify(sorted));

        // ── The task page: open, edit ──────────────────────────────────────
        const barBtn = t => `${BAR()}.find(b => b.textContent === ${JSON.stringify(t)})`;
        const onPage = (id) => until(`!!document.querySelector('${root} #team-task-title') && document.querySelector('${root} #team-task-title').textContent.startsWith('#${id} ') && ${BAR()}.length > 0`, `the page of task ${id}`);
        await ev(`${row(made.open)}.click(); true`);
        await onPage(made.open);
        check('a dock row opens its task preview, and no dialog', !(await dlgOpen()));
        await ev(`${barBtn('Edit')}.click(); true`);
        await until(`!!document.getElementById('task-edit-title')`, 'the edit form');
        await ev(`${barBtn('Cancel')}.click(); true`);
        check('Edit, then Cancel, returns to the task', await until(`!!${barBtn('Edit')}`, 'the task bar', 3000).then(() => ev(`!!${barBtn('Edit')}`)));
        await ev(`${barBtn('Edit')}.click(); true`);
        await until(`!!document.getElementById('task-edit-title')`, 'the edit form again');
        await ev(`document.getElementById('task-edit-title').value = 'open task (edited)'; ${barBtn('Save')}.click(); true`);
        await until(`window.__req.some(r => /^(PUT|PATCH) .*\\/tasks\\/${made.open}$/.test(r))`, 'the save', 5000);
        check('Save sends the task', (await ev(`window.__req`)).some(r => new RegExp(`^(PUT|PATCH) .*/tasks/${made.open}$`).test(r)), JSON.stringify(await ev(`window.__req`)));

        // A dependency link opens that task.
        await until(`!!document.querySelector('${root} .task-dep-link[data-on-click="task-open"]')`, 'the dependency link');
        await ev(`document.querySelector('${root} .task-dep-link[data-on-click="task-open"]').click(); true`);
        check('a dependency link opens that task', await onPage(made.dep).then(() => true, () => false));

        // The pinned bar follows the one rule (#7684): right-aligned, the primary (Complete) last, Cancel task alone at the left edge and first.
        const pbar = await ev(pinnedBarProbe(`${root} .goals-pinbar`));
        check('the task page\'s bar: right-aligned, Complete last, Cancel task first at the left edge', pbar && pbar.rightAligned && pbar.primaryLast && pbar.dangerFirst && pbar.dangerAlone && pbar.names[0] === 'Cancel task' && pbar.names.at(-1) === 'Complete', JSON.stringify(pbar));

        // ── Cancel through its confirmation (on the dependency) ────────────
        await until(`!!${barBtn('Cancel task')}`, "the dependency's Cancel task");
        await ev(`${barBtn('Cancel task')}.click(); true`);
        await until(`!!document.querySelector('${root} .task-confirm-buttons')`, 'the cancel confirmation');
        const CONF = t => `[...document.querySelectorAll('${root} .task-confirm-buttons .btn')].find(b => b.textContent === ${JSON.stringify(t)})`;
        check('Cancel task asks first ("Cancel task" / "Keep task"), and asking sends nothing', !(await ev(`window.__req`)).some(r => r.includes(`/tasks/${made.dep}/cancel`)) && await ev(`!!${CONF('Keep task')}`));
        await ev(`${CONF('Keep task')}.click(); true`);
        check('Keep task restores the bar', await until(`!!${barBtn('Cancel task')}`, 'the bar', 3000).then(() => ev(`!!${barBtn('Cancel task')}`)));
        await ev(`${barBtn('Cancel task')}.click(); true`);
        await until(`!!${CONF('Cancel task')}`, 'the cancel confirmation again');
        await ev(`window.__req.length = 0; ${CONF('Cancel task')}.click(); true`);
        await until(`window.__req.some(r => r === 'POST /api/board/${BOARD}/tasks/${made.dep}/cancel')`, 'the cancel request', 5000);
        check('Cancel task in the question sends the cancel', (await ev(`window.__req`)).includes(`POST /api/board/${BOARD}/tasks/${made.dep}/cancel`), JSON.stringify(await ev(`window.__req`)));
        // A cancelled task is stored as skipped.
        await until(`fetch('/api/board/${BOARD}/tasks/${made.dep}').then(r => r.json()).then(j => ['skipped', 'cancelled'].includes((j.task || j).status))`, 'cancelled', 5000);
        check('Cancel task in the question cancels it', ['skipped', 'cancelled'].includes((await task(made.dep)).status), JSON.stringify((await task(made.dep)).status));

        await ev(`document.querySelector('#preview-pane .preview-tab.active .preview-tab-close').click(); true`);
        root = '#team-panel-item';

        // ── Publish a draft ────────────────────────────────────────────────
        await ev(`window.openTeamPage(${JSON.stringify(BOARD)}, { tab: 'tasks', item: ${made.draft} }); true`);
        await onPage(made.draft);
        await until(`!!${barBtn('Publish')}`, "the draft's Publish");
        await ev(`${barBtn('Publish')}.click(); true`);
        await until(`fetch('/api/board/${BOARD}/tasks/${made.draft}').then(r => r.json()).then(j => (j.task || j).status !== 'draft')`, 'published', 5000);
        check('Publish publishes a draft', (await task(made.draft)).status !== 'draft', JSON.stringify(await task(made.draft)));

        // ── Nudge, Remind, Stop on a claimed task; Complete through its form ─
        await ev(`window.openTeamPage(${JSON.stringify(BOARD)}, { tab: 'tasks', item: ${made.claimed} }); true`);
        await onPage(made.claimed);
        await until(`!!${barBtn('Nudge')}`, "the claimed task's Nudge");
        // Remind asks for its interval in its own dialog (#6329; window.prompt would block the page and does not exist in the native app): accept the 5 minutes it offers.
        await ev(`window.prompt = () => { throw new Error('window.prompt must not be used'); }; window.__req.length = 0; ${barBtn('Nudge')}.click(); ${barBtn('Remind')}.click(); true`);
        await until(`document.getElementById('reminder-dialog')?.open === true`, 'the reminder dialog', 5000);
        await ev(`document.querySelector('#reminder-dialog .reminder-go').click(); true`);
        await until(`window.__req.some(r => r.includes('/nudge')) && window.__req.some(r => r.startsWith('POST') && r.includes('/reminder'))`, 'nudge and remind', 5000);
        await ev(`${barBtn('Stop reminders')}.click(); true`);
        await until(`window.__req.some(r => r.startsWith('DELETE') && r.includes('/reminder'))`, 'stop', 5000);
        const nr = await ev(`window.__req`);
        check('Nudge, Remind and Stop reminders reach the task', ['/nudge', 'POST', 'DELETE'].every(k => nr.some(r => r.includes(k))), JSON.stringify(nr));
        await ev(`${barBtn('Complete')}.click(); true`);
        await until(`!!document.getElementById('task-complete-message') && !!${barBtn('Back')}`, 'the completion form');
        await ev(`${barBtn('Back')}.click(); true`);
        check('Complete opens its form, and Back returns', await until(`!!${barBtn('Complete')} && !document.getElementById('task-complete-message')`, 'the bar', 3000).then(() => ev(`!!${barBtn('Complete')}`)));
        await ev(`${barBtn('Complete')}.click(); true`);
        await until(`!!document.getElementById('task-complete-message') && !!${barBtn('Back')}`, 'the completion form again');
        await ev(`${BAR()}.filter(b => b.textContent === 'Complete').pop().click(); true`);
        await until(`fetch('/api/board/${BOARD}/tasks/${made.claimed}').then(r => r.json()).then(j => (j.task || j).status === 'completed')`, 'completed', 5000);
        check('Complete completes it', (await task(made.claimed)).status === 'completed', JSON.stringify(await task(made.claimed)));

        // ── A bad id; the artifact link ────────────────────────────────────
        const bad = await ev(`(() => { let opened = null; const keep = window.openTeamPage; window.openTeamPage = (b, o) => { opened = o; };
            const b = document.createElement('div'); b.setAttribute('data-on-click', 'task-open'); b.dataset.taskId = '1 OR 1'; document.body.appendChild(b); b.click(); b.remove();
            window.openTeamPage = keep; return opened; })()`);
        check('a task link with a bad id does nothing', bad === null, String(bad));
        const art = await ev(`(() => { const seen = []; const keep = window.openFilePreview; window.openFilePreview = u => seen.push(u);
            const mk = uri => { const a = document.createElement('a'); a.href = '#'; a.setAttribute('data-on-click', 'task-artifact-open'); a.dataset.artifactUri = uri; document.body.appendChild(a); const e = new MouseEvent('click', { bubbles: true, cancelable: true }); a.dispatchEvent(e); a.remove(); return e.defaultPrevented; };
            const p1 = mk('coral://artifacts/${'b'.repeat(64)}'), p2 = mk('javascript:alert(1)');
            window.openFilePreview = keep; return { seen, p1, p2 }; })()`);
        check('the artifact link opens only a coral:// artifact, and never navigates', JSON.stringify(art.seen) === JSON.stringify(['coral://artifacts/' + 'b'.repeat(64)]) && art.p1 && art.p2, JSON.stringify(art));

        // ── The dependency picker (the create-task dialog) ─────────────────
        await ev(`(async () => { ${MODS}
            if (typeof window.showCreateTaskModal === 'function') await window.showCreateTaskModal();
            return true;
        })()`);
        // The picker renders after the dialog loads its tasks: wait for its link (up to 3 s).
        await waitFor(`!!document.querySelector('#create-task-deps [data-on-click="dep-picker-toggle"]')`, 'the dependency picker link', { timeout: 3000, soft: true });
        const picker = await ev(`(async () => { ${MODS}
            const box = document.getElementById('create-task-deps');
            const add = box && box.querySelector('[data-on-click="dep-picker-toggle"]');
            if (!add) return { box: !!box };
            const list = document.getElementById('create-task-deps-list');
            const d0 = list.style.display; add.click(); const d1 = list.style.display;
            const cb = list.querySelector('input[type="checkbox"][data-on-change="dep-picker-change"]');
            cb.click();
            const tags1 = document.querySelectorAll('#create-task-deps-tags .dep-tag').length;
            document.querySelector('#create-task-deps-tags [data-on-click="dep-tag-remove"]').click();
            const tags2 = document.querySelectorAll('#create-task-deps-tags .dep-tag').length;
            window.hideCreateTaskModal && window.hideCreateTaskModal();
            return { box: true, toggled: d0 !== d1, tags1, tags2, unchecked: !cb.checked };
        })()`);
        check('+ Add dependency shows the list; a checkbox makes a tag; its × removes it', picker.toggled && picker.tags1 === 1 && picker.tags2 === 0 && picker.unchecked, JSON.stringify(picker));

        await ev(`window.openTeamPage(${JSON.stringify(BOARD)}, { tab: 'tasks', item: ${made.open} }); true`);
        await onPage(made.open);
        const inline = await ev(`[...document.querySelectorAll('#board-task-list *, ${root} *, #create-task-deps *')].flatMap(el => [...el.attributes].filter(a => /^on/i.test(a.name)).map(a => el.tagName + '.' + el.className + ' ' + a.name))`);
        check('no inline handler left in the task list, the task page or the dependency picker', inline.length === 0, JSON.stringify(inline.slice(0, 5)));
    } catch (e) {
        check('the test ran', false, e.stack || String(e));
    } finally {
        await removeBoards(ev, [BOARD]);
        await client.close();
    }
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
