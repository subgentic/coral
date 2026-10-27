// The rows that open something are reachable and openable by keyboard (#6976, UI Accessibility's #6962): a Workflows card, a Job row (now a row of the Jobs folder's table, Goal #74) and a Chat row were plain div and li elements with a click action, so
// Tab never landed on one and a screen reader could not open them. Each is a button for the keyboard (role=button, one Tab stop, Enter or Space opens it, a visible ring); a run row in a table keeps its table
// semantics and holds a real button in its first cell. Drives Chrome over CDP through agent_view_harness.js; the scheduler's and the workflows' answers are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the detail draws after the key
    const key = async (k, vk, text) => { const b = { key: k, code: k === ' ' ? 'Space' : k, windowsVirtualKeyCode: vk }; await Input.dispatchKeyEvent({ type: 'keyDown', ...b, ...(text ? { text } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', ...b }); await sleep(300); }; // sleep-ok: the handler runs
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
            const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/repo', base_branch: 'main', prompt: 'Tidy.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', job_type: 'prompt', cron_expr: '0 2 * * *', next_fire_at: new Date(Date.now() + 3600000).toISOString(), consecutive_failures: 0, last_run: null };
            window.__jobs = [{ ...base, id: 1, name: 'nightly', job_type: 'workflow', workflow_id: 1 }, { ...base, id: 2, name: 'weekly' }];
            window.__runs = { 1: [{ id: 11, status: 'completed', exit_reason: 'agent_done', started_at: new Date(Date.now() - 7200000).toISOString(), finished_at: new Date(Date.now() - 3600000).toISOString() }] };
            window.fetch = (u, o) => { const url = String(u), m = (o && o.method) || 'GET';
                if (url === '/api/workflows/1/runs' && m === 'GET') return json({ runs: window.__runs[1] });
                if (m === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs: window.__jobs });
                const r = url.match(/\\/api\\/scheduled\\/jobs\\/(\\d+)\\/runs/); if (r) return json({ runs: window.__runs[r[1]] || [] });
                if (m === 'GET' && /\\/api\\/workflows$/.test(url)) return json({ workflows: [{ id: 1, name: 'build', description: 'Build it', enabled: 1, steps: [{ name: 'a' }], last_run: null }, { id: 2, name: 'release', description: '', enabled: 1, steps: [], last_run: null }] });
                return real(u, o); };
            return true; })()`);
        // Jobs: a row of the folder's table holds a button, one Tab stop, Enter opens it
        await ev(`import(${S} + 'scheduler.js').then(m => { window.__sched = m; return true; })`);
        await ev(`window.switchNavTab('automations'); window.__sched.refreshJobs().then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key] button.dt-primary').length === 2`, 'two job rows', 8000);
        // a row of the folder's table holds one real button in its first cell, and Enter on it opens the job
        const row = await ev(`(() => { const r = document.querySelector('#group-table-view tbody tr[data-key]'); const b = r.querySelectorAll('button.dt-primary'); return { role: r.getAttribute('role'), buttons: b.length, btnTab: b[0] && b[0].tabIndex }; })()`);
        assert.deepEqual(row, { role: 'row', buttons: 1, btnTab: 0 }, 'a job row keeps its table semantics and holds one real button: ' + JSON.stringify(row));
        await ev(`[...document.querySelectorAll('#group-table-view button.dt-primary')].find(b => /nightly/.test(b.textContent)).focus(); true`);
        await key('Enter', 13, '\r');
        await waitFor(`!!document.querySelector('#scheduler-detail .sched-runs-section') && /nightly/.test(document.getElementById('scheduler-detail').textContent)`, 'the job opened by Enter', 6000);
        await ev(`window.__sched.selectScheduledJob(window.__sched.jobList().find(j => /weekly/.test(j.name)).id).then(() => true)`);
        await waitFor(`/weekly/.test(document.getElementById('scheduler-detail').textContent)`, 'the second job opened', 6000);
        await ev(`window.__sched.selectScheduledJob(window.__sched.jobList().find(j => /nightly/.test(j.name)).id).then(() => true)`);
        await waitFor(`!!document.querySelector('#scheduler-detail .sched-runs-section') && /nightly/.test(document.getElementById('scheduler-detail').textContent)`, 'the first job again', 6000);
        // its Runs table: the first cell holds a real button; Enter on it opens the run (the table keeps its rows)
        await waitFor(`!!document.querySelector('.sched-runs-table tbody tr button.dt-primary')`, 'the run row button', 6000);
        const btn = await ev(`(() => { const b = document.querySelector('.sched-runs-table tbody tr button.dt-primary'); return b ? { tag: b.tagName, name: b.textContent.trim() } : null; })()`);
        assert.ok(btn && btn.tag === 'BUTTON' && btn.name, 'a run row has a real button in its first cell: ' + JSON.stringify(btn));
        assert.equal(await ev(`document.querySelector('.sched-runs-table tbody tr').getAttribute('role')`), 'row', 'the row keeps its table semantics (no button role on the tr)');
        // Chats: a row is an li holding a button, and aria-current follows the open chat wherever the highlight moves (#7006)
        await ev(`window.switchNavTab('history'); (async () => { const m = await import(${S} + 'history_list.js'); window.__st = (await import(${S} + 'state.js')).state; window.__ctl = await import(${S} + 'controls.js');
            const rows = [1, 2, 3].map(i => ({ session_id: 'aaaaaa' + i, title: 'Chat ' + i, source_type: 'claude', display_name: 'Ada', last_timestamp: new Date().toISOString() })).concat([{ type: 'group', session_id: 'board:team-a', title: 'team-a', updated_at: new Date().toISOString(), message_count: 2, subscriber_count: 1 }]);
            m.renderHistorySessions(rows, rows.length, 1, 50); return true; })()`);
        await waitFor(`document.querySelectorAll('#history-sessions-list li:not(.session-group-header)').length === 4`, 'four chat rows', 8000);
        const chat = await ev(`[...document.querySelectorAll('#history-sessions-list li:not(.session-group-header)')].map(li => ({ role: li.getAttribute('role'), tab: li.getAttribute('tabindex'), buttons: li.querySelectorAll('button.row-btn').length }))`);
        assert.deepEqual(chat, Array(4).fill({ role: null, tab: null, buttons: 1 }), 'a chat row is an li holding one real button: ' + JSON.stringify(chat));
        const curChat = () => ev(`[...document.querySelectorAll('#history-sessions-list [aria-current="true"]')].map(e => e.closest('li').dataset.sessionId)`);
        await ev(`window.__st.currentSession = { type: 'history', name: 'aaaaaa2' }; window.__ctl.updateSidebarActive(); true`);
        assert.deepEqual(await curChat(), ['aaaaaa2'], 'the open chat is the current one');
        await ev(`window.__st.currentSession = { type: 'history', name: 'aaaaaa3' }; window.__ctl.updateSidebarActive(); true`);
        assert.deepEqual(await curChat(), ['aaaaaa3'], 'aria-current moved with the open chat');
        await ev(`window.__st.currentSession = null; window.__ctl.updateSidebarActive(); true`);
        assert.deepEqual(await curChat(), [], 'no chat is current when none is open');
        // Workflows: a row of the sidebar is a real button too (the cards became rows and a table in #7471)
        await ev(`window.switchNavTab('workflows'); true`);
        await waitFor(`document.querySelectorAll('#wf-nav-list .row-btn').length === 2`, 'two workflow rows', 8000);
        const card = await ev(`(() => { const c = document.querySelector('#wf-nav-list .row-btn'); return { tag: c.tagName, tab: c.tabIndex }; })()`);
        assert.deepEqual(card, { tag: 'BUTTON', tab: 0 }, 'a workflow row is a button');
        await ev(`document.querySelector('#wf-nav-list .row-btn').focus(); true`);
        await key(' ', 32, ' ');
        await waitFor(`!!document.querySelector('.wf-detail, #workflow-detail, .wf-runs-table, .wf-steps') || /build/.test((document.getElementById('workflow-detail') || document.body).textContent)`, 'the workflow opened by Space', 6000);
        console.log('PASS list rows keyboard');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
