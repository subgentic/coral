// Automations, Recent runs (#9296, audit #9255 item 3): a folder next to Running now and Failed that lists every run of every job and workflow, newest first, one line each (Run, Kind, Result, Started, Took),
// with a dot before the name of a finished run nobody has opened and the folder's count the number of those; a run a job made of its workflow is listed once (the job's); opening a run opens its job's or
// its workflow's page and clears its dot and the count. A failed run nobody has opened is also a row of the Inbox's Needs you (Item, "Run failed: why", Open and Dismiss), counted in the Inbox badge; Dismiss
// or Open takes it out. 1280 and 390 px, a stubbed server (jobs, workflows and the two recent-runs reads), light and dark. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const { oneLinePerRow } = require('./helpers/row_lines');
const BASE = require('./test_base').BASE;

const STUB = `(() => {
    const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
    const ago = m => new Date(Date.now() - m * 60000).toISOString(), inn = h => new Date(Date.now() + h * 3600000).toISOString();
    const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/project', base_branch: 'main', prompt: 'Do it.', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', consecutive_failures: 0 };
    window.__jobs = [
        { ...base, id: 1, name: 'nightly-build-job', cron_expr: '0 2 * * *', workflow_id: 7, next_fire_at: inn(20), last_run: { id: 105, status: 'failed', started_at: ago(30), finished_at: ago(29) } },
        { ...base, id: 2, name: 'summarize-the-day', cron_expr: '0 18 * * 1-5', next_fire_at: inn(30), last_run: { id: 104, status: 'completed', started_at: ago(120), finished_at: ago(118) } },
        { ...base, id: 4, name: 'watch-the-queue', cron_expr: '*/5 * * * *', next_fire_at: inn(0.1), last_run: { id: 103, status: 'running', started_at: ago(3) } },
    ];
    window.__wfs = [
        { id: 7, name: 'nightly-build', description: 'Build and test', enabled: 1, step_count: 2, steps: [{ name: 'Install' }, { name: 'Test' }], last_run: { id: 202, status: 'failed', started_at: ago(60) } },
        { id: 8, name: 'review-pass', description: '', enabled: 1, step_count: 1, steps: [{ type: 'agent' }], last_run: { id: 200, status: 'completed', started_at: ago(300) } },
    ];
    window.__jobRuns = [
        { id: 105, job_id: 1, job_name: 'nightly-build-job', status: 'failed', scheduled_at: ago(30), started_at: ago(30), finished_at: ago(29), error_msg: 'step 2 (Test) failed with exit code 3', trigger_type: 'cron' },
        { id: 104, job_id: 2, job_name: 'summarize-the-day', status: 'completed', scheduled_at: ago(120), started_at: ago(120), finished_at: ago(118), trigger_type: 'cron' },
        { id: 103, job_id: 4, job_name: 'watch-the-queue', status: 'running', scheduled_at: ago(3), started_at: ago(3), trigger_type: 'cron' },
    ];
    window.__wfRuns = [
        { id: 203, workflow_id: 7, workflow_name: 'nightly-build', status: 'failed', trigger_type: 'scheduled', trigger_context: '{"scheduled_job_id":1,"scheduled_run_id":105}', started_at: ago(30), finished_at: ago(29), created_at: ago(30) },
        { id: 202, workflow_id: 7, workflow_name: 'nightly-build', status: 'failed', trigger_type: 'ui', started_at: ago(60), finished_at: ago(59), created_at: ago(60), failure_reason: 'Step 2, Test, failed with exit code 3' },
        { id: 200, workflow_id: 8, workflow_name: 'review-pass', status: 'completed', trigger_type: 'ui', started_at: ago(300), finished_at: ago(299), created_at: ago(300) },
    ];
    window.fetch = (u, o) => {
        const url = String(u), method = (o && o.method) || 'GET';
        if (method === 'GET' && /\\/api\\/scheduled\\/runs\\/recent/.test(url)) return json({ runs: window.__jobRuns });
        if (method === 'GET' && /\\/api\\/workflows\\/runs\\/recent/.test(url)) return json({ runs: window.__wfRuns });
        if (method === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs: window.__jobs });
        if (/\\/api\\/scheduled\\/jobs\\/(\\d+)\\/runs/.test(url)) return json({ runs: [], total: 0 });
        if (method === 'GET' && /\\/api\\/workflows$/.test(url)) return json({ workflows: window.__wfs });
        if (method === 'GET' && /\\/api\\/workflows\\/\\d+\\/runs/.test(url)) return json({ runs: [], total: 0 });
        const run = /\\/api\\/workflows\\/runs\\/(\\d+)$/.exec(url);
        if (method === 'GET' && run) { const r = window.__wfRuns.find(x => x.id === Number(run[1])); return r ? json({ ...r, steps: [] }) : json({ error: 'not found' }, 404); }
        const one = /\\/api\\/workflows\\/(\\d+)$/.exec(url);
        if (method === 'GET' && one) return json(window.__wfs.find(w => w.id === Number(one[1])));
        return real(u, o);
    };
    return true; })()`;

(async () => {
    const { Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const shot = require('./helpers/scene_shots')(Page, 'automations-recent');
    const themed = async (name, w) => { for (const theme of ['dark', 'light']) { await setTheme(ev, theme); await settle(150); await shot(`${name}-${theme}-${w}`); } await setTheme(ev, 'dark'); };
    const rows = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(tr => tr.querySelector('.dt-primary').textContent.trim().replace(/^Not opened: /, '') + '|' + (tr.querySelector('.chip:not(.dt-tag)') || {}).textContent + '|' + (tr.querySelector('.automations-unread') ? 'unread' : 'read'))`);
    const folderWords = mobile => ev(mobile ? `[...document.querySelectorAll('#group-table-view .view-list-select option')].map(o => o.textContent.trim())` : `[...document.querySelectorAll('.view-list-item')].map(b => b.textContent.trim().replace(/\\s+/g, ' '))`);
    const pathname = () => ev(`location.pathname`);
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        // this browser first looked a day ago: every run of the stub is after that
        await Page.addScriptToEvaluateOnNewDocument({ source: `try { if (!localStorage.getItem('coral-automation-runs-seen')) localStorage.setItem('coral-automation-runs-seen', JSON.stringify({ since: Date.now() - 86400000, ids: [] })); } catch {}` });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`try { localStorage.setItem('coral-automation-runs-seen', JSON.stringify({ since: Date.now() - 86400000, ids: [] })); for (const k of Object.keys(localStorage)) if (k.startsWith('coral-automations-')) localStorage.removeItem(k); } catch {} true`);
            await ev(`window.openAutomationsFolder('recent'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 5`, `${at}the five runs in Recent runs`, 10000);
            assert.equal(await pathname(), '/automations/recent', `${at}the address is the folder's`);
            assert.deepEqual(await folderWords(mobile), mobile ? ['Running now (1)', 'Failed (2)', 'Recent runs (4)', 'Jobs (3)', 'Workflows (2)'] : ['Running now1', 'Failed2', 'Recent runs4', 'Jobs3', 'Workflows2'], `${at}Recent runs is a folder of Needs attention and counts the runs not opened`);
            assert.deepEqual(await rows(), ['watch-the-queue|Running|read', 'nightly-build-job|Failed|unread', 'nightly-build|Failed|unread', 'summarize-the-day|Passed|unread', 'review-pass|Passed|unread'],
                `${at}every run newest first, the job's run once (the workflow run it made is left out), a dot on each finished run, none on the one still going`);
            const cols = await ev(`[...document.querySelectorAll('#group-table-view table th')].filter(h => h.getClientRects().length).map(h => (h.querySelector('.dt-sort > span, .dt-head-text') || h).textContent.trim()).filter(Boolean)`);
            assert.deepEqual(cols, mobile ? ['Run', 'Result'] : ['Run', 'Kind', 'Result', 'Started', 'Took'], `${at}the columns (a phone keeps the run, whole, and its result): ${JSON.stringify(cols)}`);
            if (!mobile) assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-time')].map(e => /^(today|yesterday|[A-Z][a-z]{2} \\d+) \\d\\d:\\d\\d$/.test(e.textContent.trim()))`), [true, true, true, true, true], `${at}every run says when it started, in words`);
            if (!mobile) assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(tr => tr.lastElementChild.textContent.trim())`), ['', '1 min', '1 min', '2 min', '1 min'], `${at}a finished run says how long it took, one still going says nothing`);
            assert.equal(await ev(`document.querySelector('#group-table-view .list-bar-search').getAttribute('aria-label')`), 'Search recent runs', `${at}the search is named for the folder`);
            await oneLinePerRow(ev, '#group-table-view tbody tr[data-key]', `${at}Recent runs`, assert, { min: 5 });
            assert.equal(await ev(`document.documentElement.scrollWidth <= window.innerWidth`), true, `${at}nothing wider than the screen`);
            await themed('recent', w);

            // the Inbox: the two failed runs nobody has opened are rows of Needs you, counted in the badge; Dismiss takes one out
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelector('.top-nav-tab.active')?.dataset.arg === 'hub-inbox' && !document.getElementById('inbox-local').hidden`, `${at}the Inbox`, 10000);
            if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); if (s) { s.value = 'needs'; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`); else await ev(`(() => { const b = document.querySelector('.view-list-item[data-key="needs"]'); if (b && !b.classList.contains('view-list-current')) b.click(); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 2`, `${at}the two failed runs in Needs you`, 10000);
            const needs = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(tr => ({ name: (tr.querySelector('.inbox-review-name') || {}).textContent, text: tr.textContent.replace(/\\s+/g, ' ').trim() }))`);
            const rowsText = await needs(), byName = n => rowsText.find(r => r.name === n);
            assert.ok(byName('nightly-build-job') && /Run failed: step 2 \(Test\) failed with exit code 3/.test(byName('nightly-build-job').text), `${at}the job's failed run says why: ${JSON.stringify(rowsText)}`);
            assert.ok(byName('nightly-build') && /Run failed: Step 2, Test, failed with exit code 3/.test(byName('nightly-build').text), `${at}and the workflow's: ${JSON.stringify(rowsText)}`);
            assert.equal(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`), '2', `${at}the Inbox badge counts them`);
            await themed('needs', w);
            await ev(`document.querySelector('#group-table-view button[aria-label^="Dismiss the failed run of nightly-build-job"]').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 1`, `${at}Dismiss takes the run out`, 8000);
            assert.equal(await ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`), '1', `${at}and the badge goes down`);
            assert.equal(await pathname().then(p => /^\/automations\//.test(p)), false, `${at}Dismiss does not open the run`);
            await ev(`document.querySelector('#group-table-view button[aria-label^="Open nightly-build, failed run"]').click(); true`);
            await waitFor(`location.pathname === '/automations/workflows/7/runs/202'`, `${at}Open goes to the workflow's run page`, 8000);
            assert.equal(await ev(`document.getElementById('nav-tab-hub-inbox-badge').hidden`), true, `${at}and the badge is gone: nothing needs you`);

            // back in Recent runs: both failed runs are read, the other two still have their dots
            await ev(`window.openAutomationsFolder('recent'); true`);
            await waitFor(`document.querySelector('#group-table-title') && document.querySelector('#group-table-title').textContent === 'Recent runs' && document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 5`, `${at}Recent runs again`, 8000);
            assert.deepEqual(await rows(), ['watch-the-queue|Running|read', 'nightly-build-job|Failed|read', 'nightly-build|Failed|read', 'summarize-the-day|Passed|unread', 'review-pass|Passed|unread'], `${at}the dismissed and the opened failed runs lost their dots, the passed ones keep theirs`);
            assert.equal((await folderWords(mobile))[2], mobile ? 'Recent runs (2)' : 'Recent runs2', `${at}and the count is the two`);
            // opening a job's run opens the job's page, and Back returns to the folder
            await ev(`[...document.querySelectorAll('#group-table-view button.dt-primary')].find(b => /summarize-the-day/.test(b.textContent)).click(); true`);
            await waitFor(`!!document.querySelector('#scheduler-detail .sched-header')`, `${at}the job's page`, 8000);
            assert.equal(await pathname(), '/automations/jobs/2', `${at}a job's run opens the job's page`);
            await ev(`[...document.querySelectorAll('[data-on-click="automations-back"]')].find(b => b.getClientRects().length).click(); true`);
            await waitFor(`document.querySelector('#group-table-title') && document.querySelector('#group-table-title').textContent === 'Recent runs'`, `${at}Back is Recent runs`, 8000);
            assert.equal(await pathname(), '/automations/recent', `${at}Back returns to the folder it was opened from`);
            // no runs at all: one line and its hint
            await ev(`window.__jobRuns = []; window.__wfRuns = []; import(${S} + 'automation_runs.js').then(m => m.refreshRuns(true)).then(() => true)`);
            await waitFor(`!!document.querySelector('#group-table-view .empty-state .empty-state-line')`, `${at}the empty folder`, 8000);
            assert.equal(await ev(`document.querySelector('#group-table-view .empty-state .empty-state-line').textContent`), 'Nothing has run yet.', `${at}one empty line`);
            console.log(`${at}ok`);
        }
        console.log('automations_recent_runs_browser: ok');
        process.exit(0);
    } catch (e) { console.error(e); process.exit(1); }
})();
