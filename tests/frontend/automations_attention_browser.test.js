// Automations, the two folders that need attention (Goal #74, UI/UX #8862): Running now (the jobs and workflows with a run going, and a run with no job of its own) and Failed (those whose last run failed) are
// folders of the sidebar's "Needs attention" section, with their counts (Failed's a red pill while it is above zero); each is one table of jobs and workflows together (Name with what it is under it, Kind, Schedule,
// Last run, Next) on the shared toolbar with a New menu (New job, New workflow) and no pills; a row opens its job or workflow in place, and Back returns to the folder it was opened from. 1280 and 390 px, a stubbed
// server and the websocket's live runs fed through live_jobs.js. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const STUB = `(() => {
    const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
    const ago = h => new Date(Date.now() - h * 3600000).toISOString(), inn = h => new Date(Date.now() + h * 3600000).toISOString();
    const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/project', base_branch: 'main', prompt: 'Do it.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', consecutive_failures: 0 };
    window.__jobs = [
        { ...base, id: 1, name: 'nightly-build-job', cron_expr: '0 2 * * *', workflow_id: 7, next_fire_at: inn(20), consecutive_failures: 1, last_run: { id: 11, status: 'failed', error_msg: 'step 2 (Test) failed', started_at: ago(8), finished_at: ago(8) } },
        { ...base, id: 2, name: 'summarize-the-day', cron_expr: '0 18 * * 1-5', next_fire_at: inn(30), last_run: { id: 12, status: 'completed', started_at: ago(5), finished_at: ago(5) } },
        { ...base, id: 3, name: 'weekly-cleanup', cron_expr: '0 9 * * 1', enabled: 0, next_fire_at: null, last_run: null },
        { ...base, id: 4, name: 'watch-the-queue', cron_expr: '*/5 * * * *', next_fire_at: inn(0.1), last_run: { id: 14, status: 'running', started_at: ago(0.05) } },
    ];
    window.__wfs = [
        { id: 7, name: 'nightly-build', description: 'Build and test', enabled: 1, step_count: 2, steps: [{ name: 'Install' }, { name: 'Test' }], last_run: { id: 21, status: 'failed', started_at: ago(8), failed_step: { number: 2, name: 'Test' } } },
        { id: 8, name: 'review-pass', description: '', enabled: 1, step_count: 1, steps: [{ type: 'agent' }], last_run: { id: 22, status: 'running', started_at: ago(0.2) } },
        { id: 9, name: 'old-flow', description: '', enabled: 0, step_count: 0, steps: [], last_run: null },
    ];
    window.fetch = (u, o) => {
        const url = String(u), method = (o && o.method) || 'GET';
        if (method === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs: window.__jobs });
        if (/\\/api\\/scheduled\\/jobs\\/(\\d+)\\/runs/.test(url)) return json({ runs: [], total: 0 });
        if (method === 'GET' && /\\/api\\/workflows$/.test(url)) return json({ workflows: window.__wfs });
        if (method === 'GET' && /\\/api\\/workflows\\/\\d+\\/runs/.test(url)) return json({ runs: [], total: 0 });
        const one = /\\/api\\/workflows\\/(\\d+)$/.exec(url);
        if (method === 'GET' && one) return json(window.__wfs.find(w => w.id === Number(one[1])));
        return real(u, o);
    };
    return true; })()`;

(async () => {
    const { Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const rows = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(tr => tr.querySelector('.dt-primary').textContent.trim() + '|' + (tr.querySelector('.dt-tag') || {}).textContent)`);
    const pathname = () => ev(`location.pathname`);
    const folderWords = mobile => ev(mobile ? `[...document.querySelectorAll('#group-table-view .view-list-select option')].map(o => o.textContent.trim())` : `[...document.querySelectorAll('.view-list-item')].map(b => b.textContent.trim().replace(/\\s+/g, ' '))`);
    const live = runs => ev(`import((window.__coralStatic || '/static/') + 'live_jobs.js').then(m => m.renderLiveJobs(${JSON.stringify(runs)})).then(() => true)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`try { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-automations-')) localStorage.removeItem(k); } catch {} true`);
            await ev(`window.openAutomationsFolder('failed'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 2`, `${at}the two failures in the Failed folder`, 10000);
            assert.equal(await pathname(), '/automations/failed', `${at}the address is the folder's`);
            assert.deepEqual(await folderWords(mobile), mobile ? ['Running now (2)', 'Failed (2)', 'Jobs (4)', 'Workflows (3)'] : ['Running now2', 'Failed2', 'Jobs4', 'Workflows3'], `${at}the folders with their counts: Needs attention, then the library`);
            if (!mobile) {
                assert.deepEqual(await ev(`[...document.querySelectorAll('.view-list-title')].map(e => e.textContent.trim())`), ['Needs attention', 'Library'], `${at}two sections`);
                assert.equal(await ev(`!!document.querySelector('.view-list-item[data-key="failed"] .view-list-alert')`), true, `${at}Failed's count is the red pill`);
                assert.equal(await ev(`!!document.querySelector('.view-list-item[data-key="running"] .view-list-alert')`), false, `${at}and Running now's is not`);
            }
            assert.deepEqual((await rows()).sort(), ['nightly-build-job|Job', 'nightly-build|Workflow'].sort(), `${at}Failed lists the job and the workflow whose last run failed, each tagged with its kind`);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view table th')].map(h => h.querySelector('.dt-sort > span, .dt-head-text').textContent)`), ['Name', 'Kind', 'Schedule', 'Last run', 'Next'], `${at}the five columns`);
            assert.equal(await ev(`document.querySelector('#group-table-view .team-tb-pills')`), null, `${at}no pills: the folder is the filter`);
            assert.equal(await ev(`document.querySelector('#group-table-view .list-bar-search').getAttribute('aria-label')`), 'Search what failed', `${at}the search is named for the folder`);
            // the New menu makes either kind
            assert.equal(await ev(`document.querySelector('#automations-new-btn').textContent.trim()`), 'New', `${at}a New button at the toolbar's right`);
            await ev(`document.querySelector('#automations-new-btn').click(); true`); await settle(200);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#automations-new-menu [role=menuitem]')].filter(b => b.getClientRects().length).map(b => b.textContent.trim())`), ['New job', 'New workflow'], `${at}its menu has New job and New workflow`);
            assert.equal(await ev(`document.querySelector('#automations-new-btn').getAttribute('aria-expanded')`), 'true');
            await ev(`document.querySelector('#automations-new-btn').click(); true`); await settle(200);

            // Running now: their own last run, the websocket's live run of a job, and a run with no job of its own
            await ev(`window.openAutomationsFolder('running'); true`);
            await waitFor(`document.querySelector('#group-table-title') && document.querySelector('#group-table-title').textContent === 'Running now'`, `${at}the Running now folder`, 8000);
            assert.deepEqual((await rows()).sort(), ['review-pass|Workflow', 'watch-the-queue|Job'].sort(), `${at}Running now lists the job and the workflow whose last run is going`);
            await live([{ id: 50, job_id: 2, job_name: 'summarize-the-day', status: 'running', started_at: new Date().toISOString(), session_id: 'abc', agent_type: 'claude', trigger_type: 'cron' }, { id: 51, status: 'running', trigger_type: 'api', job_name: null, started_at: new Date().toISOString() }]);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 4`, `${at}the live runs join Running now`, 6000);
            assert.deepEqual((await rows()).sort(), ['Job run 51|One-off', 'review-pass|Workflow', 'summarize-the-day|Job', 'watch-the-queue|Job'].sort(), `${at}a live run of a job is the job, an API run with no job is a One-off row`);
            assert.equal(await ev(`document.querySelector('#live-jobs-status').textContent`), '2 jobs running now', `${at}and the status line says it once`);
            await live([]);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 2`, `${at}the live runs leave when they end`, 6000);

            // a row opens its page; Back returns to the folder it was opened from
            await ev(`window.openAutomationsFolder('failed'); true`);
            await waitFor(`document.querySelector('#group-table-title').textContent === 'Failed' && document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 2`, `${at}back in Failed`, 8000);
            await ev(`[...document.querySelectorAll('#group-table-view button.dt-primary')].find(b => b.textContent.trim() === 'nightly-build').click(); true`);
            await waitFor(`!!document.querySelector('#wf-detail .item-bar')`, `${at}the workflow's page`, 8000);
            assert.equal(await pathname(), '/automations/workflows/7', `${at}a workflow row opens the workflow in place`);
            await ev(`[...document.querySelectorAll('#wf-detail [data-on-click="automations-back"]')].find(b => b.getClientRects().length).click(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility() && document.querySelector('#group-table-title').textContent === 'Failed'`, `${at}Back is Failed`, 8000);
            assert.equal(await pathname(), '/automations/failed', `${at}Back returns to the folder it was opened from, not the workflow's own`);
            assert.equal(await ev(`document.activeElement && document.activeElement.textContent.trim()`), 'nightly-build', `${at}with the keyboard on its row`);
            await ev(`[...document.querySelectorAll('#group-table-view button.dt-primary')].find(b => b.textContent.trim() === 'nightly-build-job').click(); true`);
            await waitFor(`!!document.querySelector('#scheduler-detail .sched-header')`, `${at}the job's page`, 8000);
            assert.equal(await pathname(), '/automations/jobs/1', `${at}a job row opens the job in place`);

            // nothing running or failed: one line and its hint
            await ev(`window.__jobs = window.__jobs.map(j => ({ ...j, last_run: j.last_run && { ...j.last_run, status: 'completed' } })); window.__wfs = window.__wfs.map(x => ({ ...x, last_run: x.last_run && { ...x.last_run, status: 'completed' } })); window.openAutomationsFolder('failed'); true`);
            await waitFor(`document.querySelector('#group-table-title') && document.querySelector('#group-table-title').textContent === 'Failed'`, `${at}the Failed folder again`, 8000);
            await ev(`import((window.__coralStatic || '/static/') + 'scheduler.js').then(m => m.refreshJobs()).then(() => import((window.__coralStatic || '/static/') + 'workflows.js')).then(m => m.refreshWorkflows()).then(() => true)`);
            await waitFor(`!!document.querySelector('#group-table-view .empty-pane .empty-line')`, `${at}the empty Failed folder`, 8000);
            assert.equal(await ev(`document.querySelector('#group-table-view .empty-pane .empty-line').textContent`), 'Nothing has failed.', `${at}one empty line`);
            assert.equal(await ev(`document.documentElement.scrollWidth <= window.innerWidth`), true, `${at}nothing wider than the screen`);
            console.log(`${at}ok`);
        }
        console.log('automations_attention_browser: ok');
        process.exit(0);
    } catch (e) { console.error(e); process.exit(1); }
})();
