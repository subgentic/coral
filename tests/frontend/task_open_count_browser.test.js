// The Tasks tab's Open pill counts only the active tasks — pending, in progress and in review — and
// a draft task shows the state word "Draft" (not "Queued") and has its own Draft pill (#16686, walk 30
// F2 and F6).  A board is created with one task per status; the pills are read and checked at 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: panels settle
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const B = 'toc-' + Date.now().toString(36);
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        // Subscribe agents so tasks can be claimed
        for (const id of ['orch', 'dev', 'qa']) await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: id });
        // Create one task per status:
        //   t1: pending (no claim)
        //   t2: in_progress (claimed)
        //   t3: review_pending (submitted for review)
        //   t4: completed (completed)
        //   t5: draft (created as draft)
        //   t6: blocked (depends on t1)
        const mk = async (title, opts = {}) => { const r = await api('POST', `/api/board/${B}/tasks`, { title, body: '', assigned_to: 'dev', created_by: 'orch', priority: 'medium', ...opts }); assert.ok(r.status < 300, `create ${title}: ${JSON.stringify(r)}`); return r.body.id || r.body.task?.id; };
        const t1 = await mk('Task Pending');
        const t2 = await mk('Task In Progress');
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'dev', task_id: t2 })).status, 200);
        const t3 = await mk('Task In Review');
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'qa', task_id: t3 })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/tasks/${t3}/submit-review`, { subscriber_id: 'qa', reason: 'done', message: 'Ready.' })).status, 200);
        const t4 = await mk('Task Completed');
        assert.equal((await api('POST', `/api/board/${B}/tasks/${t4}/complete`, { subscriber_id: 'dev', message: 'Done.' })).status, 200);
        const t5 = await mk('Task Draft', { draft: true });
        const t6 = await mk('Task Blocked', { blocked_by: [t1] });
        // Open the team Tasks tab
        await openBoardTasksTab({ ev, waitFor }, B);
        await sleep(600); // sleep-ok: layout settles
        await waitFor(`document.querySelectorAll('#agentic-panel-tasks .board-task-item:not(.board-task-header)').length >= 5`, 'five or more tasks visible', 12000);
        await sleep(400); // sleep-ok: pills settle
        // Read the pill counts from the toolbar
        const pills = await ev(`(() => {
            const btns = [...document.querySelectorAll('#agentic-panel-tasks .goals-chips [data-filter]')];
            const out = {};
            for (const b of btns) out[b.dataset.filter] = { text: b.textContent.trim(), pressed: b.getAttribute('aria-pressed') };
            return out;
        })()`);
        // The Open pill should count only pending + in_progress + review_pending = 3
        // (t1 pending, t2 in_progress, t3 review_pending; NOT t4 completed, t5 draft, t6 blocked)
        const openText = pills.open?.text || '';
        const openCount = parseInt((openText.match(/\d+/) || ['0'])[0], 10);
        check(openCount === 3, `Open pill count should be 3 (pending+in_progress+review_pending), got "${openText}" (count ${openCount}), pills: ${JSON.stringify(pills)}`);
        // The All pill should count all 6 tasks
        const allText = pills.all?.text || '';
        const allCount = parseInt((allText.match(/\d+/) || ['0'])[0], 10);
        check(allCount === 6, `All pill count should be 6, got "${allText}" (count ${allCount})`);
        // The Draft pill should exist
        check(!!pills.draft, `Draft pill should exist, pills: ${JSON.stringify(Object.keys(pills))}`);
        // The Done pill should count 1 (completed)
        const doneText = pills.done?.text || '';
        const doneCount = parseInt((doneText.match(/\d+/) || ['0'])[0], 10);
        check(doneCount === 1, `Done pill count should be 1 (completed), got "${doneText}" (count ${doneCount})`);
        // Check the draft task's state chip says "Draft", not "Queued"
        const draftState = await ev(`(() => {
            const rows = [...document.querySelectorAll('#agentic-panel-tasks .board-task-item:not(.board-task-header)')];
            const draft = rows.find(r => /Task Draft/.test(r.textContent));
            if (!draft) return 'NOT FOUND';
            const chip = draft.querySelector('.dt-state');
            return chip ? chip.textContent.trim() : 'NO CHIP';
        })()`);
        check(draftState === 'Draft', `Draft task state should say "Draft", got "${draftState}"`);
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('task_open_count_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
