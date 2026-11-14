// The team Tasks tab's Open pill counts only the active tasks — pending, in progress and in review — and
// a draft task shows the state word "Draft" (not "Queued") and has its own Draft pill (#16686, walk 30
// F2 and F6).  A board is created with one task per status; the pills are read and checked at 1280 px.
// Each assertion fails on the parent: parent counts Draft and Blocked in Open, shows "Queued" for Draft,
// and has no Draft pill.
const assert = require('node:assert/strict');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const B = 'toc-' + Date.now().toString(36);
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    let sid = null, sname = null;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Orch' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Orch', job_title: 'Orchestrator', session_name: sname })).status < 300, 'subscribe Orch');
        for (const id of ['Dev', 'QA']) assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: id })).status < 300, `subscribe ${id}`);
        // Create one task per status:
        //   t1: pending (no claim)
        //   t2: in_progress (claimed)
        //   t3: review_pending (submitted for review)
        //   t4: completed (completed)
        //   t5: draft (created as draft)
        //   t6: blocked (depends on t1)
        const mk = async (title, opts = {}) => { const r = await api('POST', `/api/board/${B}/tasks`, { title, body: '', assigned_to: 'Dev', created_by: 'Orch', priority: 'medium', ...opts }); assert.ok(r.status < 300, `create ${title}: ${JSON.stringify(r)}`); return r.body.id || r.body.task?.id; };
        const t1 = await mk('Task Pending');
        const t2 = await mk('Task In Progress');
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'Dev', task_id: t2 })).status, 200);
        const t3 = await mk('Task In Review', { assigned_to: 'QA' });
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'QA', task_id: t3 })).status, 200);
        const sr = await api('POST', `/api/board/${B}/tasks/${t3}/submit-review`, { subscriber_id: 'QA', reason: 'done', message: 'Ready.' });
        assert.equal(sr.status, 200, `submit-review: ${JSON.stringify(sr)}`);
        const t4 = await mk('Task Completed', { assigned_to: 'Orch' });
        assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'Orch', task_id: t4 })).status, 200);
        assert.equal((await api('POST', `/api/board/${B}/tasks/${t4}/complete`, { subscriber_id: 'Orch', message: 'Done.' })).status, 200);
        const t5 = await mk('Task Draft', { draft: true });
        const t6 = await mk('Task Blocked', { blocked_by: [t1] });
        // Open the team page's Tasks tab (the pills live here, not in the agent panel's board task list)
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length >= 3`, 'three or more tasks visible', 20000);
        await waitFor(`!/Loading tasks/.test(document.getElementById('team-panel-tasks').textContent) && document.querySelector('#team-panel-tasks [data-filter="open"][aria-pressed="true"], #team-panel-tasks .goals-chip[aria-pressed="true"]')`, 'the tasks are drawn and Open is chosen', 20000);
        // Read the pill counts from the toolbar
        const pill = key => ev(`(() => { const b = [...document.querySelectorAll('#team-panel-tasks [data-filter]')].find(x => x.dataset.filter === ${JSON.stringify(key)}); return b ? { text: b.textContent.replace(/\\s+/g, ' ').trim(), pressed: b.getAttribute('aria-pressed'), title: b.title || '' } : null; })()`);
        // The Open pill should count only pending + in_progress + review_pending = 3
        // (t1 pending, t2 in_progress, t3 review_pending; NOT t4 completed, t5 draft, t6 blocked)
        const open = await pill('open');
        check(open && /Open\s*3/.test(open.text), `Open pill count should be 3 (pending+in_progress+review_pending), got ${JSON.stringify(open)}`);
        // The Open pill's tooltip should mention the 1 blocked task that is not counted (#16686 SHOULD)
        check(open && /1 blocked/.test(open.title), `Open pill tooltip should mention blocked tasks, got title="${open?.title}"`);
        // The All pill should count all 6 tasks
        const all = await pill('all');
        check(all && /All\s*6/.test(all.text), `All pill count should be 6, got ${JSON.stringify(all)}`);
        // The Draft pill should exist (the parent has no draft pill)
        const draft = await pill('draft');
        check(!!draft, `Draft pill should exist, got ${JSON.stringify(draft)}`);
        // The Done pill should count 1 (completed)
        const done = await pill('done');
        check(done && /Done\s*1/.test(done.text), `Done pill count should be 1 (completed), got ${JSON.stringify(done)}`);
        // Switch to the Draft pill to see the draft task, then check its state chip says "Draft" (the parent says "Queued")
        await ev(`document.querySelector('#team-panel-tasks [data-filter="draft"]')?.click(); true`);
        await waitFor(`document.querySelector('#team-panel-tasks [data-filter="draft"][aria-pressed="true"]')`, 'Draft pill is selected', 5000);
        await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length >= 1`, 'at least one draft task visible', 10000);
        const draftState = await ev(`(() => {
            const rows = [...document.querySelectorAll('#team-panel-tasks tbody tr.dt-row')];
            const d = rows.find(r => /Task Draft/.test(r.textContent));
            if (!d) return 'NOT FOUND';
            const chip = d.querySelector('.dt-state');
            return chip ? chip.textContent.trim() : 'NO CHIP';
        })()`);
        check(draftState === 'Draft', `Draft task state should say "Draft", got "${draftState}"`);
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exitCode = 1; return; }
    console.log('PASS task_open_count: Open pill counts pending+in_progress+review_pending, Draft pill exists, draft state says Draft');
})().catch(e => { console.error(e); process.exitCode = 1; });
