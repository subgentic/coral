// "Goal #N looks done" (#11825): an active goal whose tasks are all done is ONE row of Needs you, with its Done-when line, counted in the one Inbox number, and three actions: Close goal (the goal's page with
// its Close dialog set to Done), Not yet (hidden until a task is added) and Ignore (hidden for good, Undo in the notice). Both are kept on the machine (goal_done_hidden), so /api/needs-you agrees. A goal with
// an open task, and one with no tasks, are not rows. Real board and settings routes on the isolated dev server; 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const B = 'goal-done-' + Date.now().toString(36);

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const root = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const T = '#group-table-view';
    const doneRows = () => ev(`[...document.querySelectorAll('${T} tbody tr')].filter(tr => /looks done/.test(tr.textContent)).map(tr => ({ text: tr.textContent.replace(/\\s+/g, ' ').trim(), buttons: [...tr.querySelectorAll('button')].map(b => b.textContent.trim()) }))`);
    const openNeeds = async () => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
    };
    const task = async (gid, finish) => {
        const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); assert.ok(t.status < 300, JSON.stringify(t));
        const tid = t.json.id || t.json.task.id;
        if (finish) {
            assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid })).status < 300);
            assert.ok((await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
        }
        return tid;
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
        await root('PUT', '/api/settings', { goal_done_hidden: '[]' });
        const mk = async (title, doneWhen) => { const g = await api('POST', '/goals', { subscriber_id: 'Operator', title, done_when: doneWhen }); assert.equal(g.status, 201); return g.json.id || g.json.goal.id; };
        const gid = await mk('Ship the pilot', 'it is shipped');
        await task(gid, true);
        const openGoal = await mk('Still going', 'later'); await task(openGoal, true); await task(openGoal, false);
        await mk('No tasks yet', '');

        await openNeeds();
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the goal item', 20000);
        let rows = await doneRows();
        assert.equal(rows.length, 1, 'one row: not the goal with an open task, nor the one with no tasks: ' + JSON.stringify(rows));
        assert.match(rows[0].text, new RegExp(`Goal #${gid} looks done: Ship the pilot`));
        assert.match(rows[0].text, /Done when: it is shipped/);
        assert.deepEqual(rows[0].buttons.filter(b => /^(Close goal|Not yet|Ignore)$/.test(b)), ['Close goal', 'Not yet', 'Ignore']);
        const badge = async () => Number(await ev(`(document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent || 0`));
        const withItem = await badge(); assert.ok(withItem >= 1, 'the item is in the Inbox number: ' + withItem);
        const asked = await root('GET', '/api/needs-you?limit=50');
        assert.ok(asked.json.items.some(i => i.kind === 'goal_done' && i.id === `goal_done:${B}:${gid}`), 'the phone-push read has it too');

        // Not yet: gone here and on the machine, until a task is added
        await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => /looks done/.test(tr.textContent)).querySelector('button[aria-label^="Not yet"]').click(); true`);
        await waitFor(`!/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the item gone after Not yet', 8000);
        assert.equal(await badge(), withItem - 1, 'and out of the Inbox number');
        const saved = (await root('GET', '/api/settings')).json.settings.goal_done_hidden;
        assert.deepEqual(JSON.parse(saved), [`${B}|${gid}|1`], 'kept on the machine at the total it was pressed at');
        assert.ok(!(await root('GET', '/api/needs-you?limit=50')).json.items.some(i => i.id === `goal_done:${B}:${gid}`), 'the phone push does not keep announcing it');
        await task(gid, true);
        await openNeeds();
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the item is back after a task was added and finished', 20000);

        // #11983: opening the item reads it: it stays listed and stops counting, in the Inbox number, the badge and /api/needs-you; a task done since has a new total, and it is unread again
        const unreadBadge = await badge();
        await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => /looks done/.test(tr.textContent)).querySelector('.inbox-review-name').click(); true`);
        await waitFor(`!!document.querySelector('.goal-view, [data-goal-view], #goal-view') || /goals|goal/i.test(location.hash + location.pathname)`, 'the goal opened', 10000);
        await openNeeds();
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the opened item is still listed', 20000);
        await waitFor(`Number((document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent || 0) === ${unreadBadge - 1}`, 'and out of the Inbox number', 10000);
        assert.equal((await doneRows()).length, 1, 'listed once');
        const readSaved = JSON.parse((await root('GET', '/api/settings')).json.settings.goal_done_read);
        assert.equal(readSaved.length, 1);
        assert.match(readSaved[0], new RegExp(`^${B}\\|${gid}\\|2\\|\\d{4}-\\d\\d-\\d\\dT`), 'kept on the machine at the total and the last change it was opened at: ' + readSaved[0]);
        assert.ok(!(await root('GET', '/api/needs-you?limit=50')).json.items.some(i => i.id === `goal_done:${B}:${gid}`), 'the phone push and /api/needs-you do not count it either');
        await task(gid, true);
        await openNeeds();
        await waitFor(`Number((document.getElementById('nav-tab-hub-inbox-badge') || {}).textContent || 0) === ${unreadBadge}`, 'unread again after another task was finished', 20000);
        assert.ok((await root('GET', '/api/needs-you?limit=50')).json.items.some(i => i.id === `goal_done:${B}:${gid}`), 'and in /api/needs-you again');

        // Ignore with Undo
        await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => /looks done/.test(tr.textContent)).querySelector('button[aria-label^="Ignore"]').click(); true`);
        await waitFor(`!/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'the item gone after Ignore', 8000);
        assert.ok(JSON.parse((await root('GET', '/api/settings')).json.settings.goal_done_hidden).includes(`${B}|${gid}|*`), 'Ignore is kept');
        await waitFor(`!![...document.querySelectorAll('.toast button, [role=status] button, #toast-container button')].find(b => /^Undo$/.test(b.textContent.trim()))`, 'the Undo in the notice', 5000);
        await ev(`[...document.querySelectorAll('.toast button, [role=status] button, #toast-container button')].find(b => /^Undo$/.test(b.textContent.trim())).click(); true`);
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'Undo brings it back', 8000);

        // Close goal: the goal's page with the Close dialog set to Done; closing it takes the item away
        await ev(`[...document.querySelectorAll('${T} tbody tr')].find(tr => /looks done/.test(tr.textContent)).querySelector('button[aria-label^="Close goal"]').click(); true`);
        await waitFor(`!!document.querySelector('dialog.goals-close-dialog[open]')`, 'the Close dialog', 10000);
        assert.equal(await ev(`document.querySelector('dialog.goals-close-dialog input[name=goal-close-state]:checked')?.value`), 'done', 'set to Done');
        await ev(`[...document.querySelectorAll('dialog.goals-close-dialog button')].find(b => /^(Close goal|Close|Confirm)/.test(b.textContent.trim()) && b.type !== 'button' || /Close goal/.test(b.textContent)).click(); true`);
        await waitFor(`!document.querySelector('dialog.goals-close-dialog[open]')`, 'the dialog closes', 10000);
        await openNeeds();
        await waitFor(`!!document.querySelector('${T} tbody tr, ${T}')`, 'Needs you', 10000);
        await require('./helpers/wait').settle(ev, 600, 300); // the goals were read again when the list opened
        assert.equal((await doneRows()).length, 0, 'gone when the goal closes');
        assert.ok(!(await root('GET', '/api/needs-you?limit=50')).json.items.some(i => i.id === `goal_done:${B}:${gid}`), 'and from the phone-push read');
        console.log('\nPASS a goal that looks done is one Needs you item: Done-when line, one Inbox number, Close goal, Not yet and Ignore with Undo, kept on the machine');
    } finally { await guard.restore().catch(() => {}); await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
