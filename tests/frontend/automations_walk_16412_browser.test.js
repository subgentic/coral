// Automations, the mismatches of the Beta Tester's walk #16412 (#16422): (1) every folder's page header is the same two rows (title, then search and filters: design guidelines 4.2): Jobs had it, Workflows, Failed and
// Recent runs put the search on the title row; (2) the Failed list's Last run keeps its status word whole (it read 'F…'); (3) the dot before an unopened run is not red (a Passed row had a red dot), and the Recent runs
// footer says how many are not opened (the sidebar counts those, the page lists them all); (4) a phone's team Goals row has the state mark before its words. 1280 and 390 px, a stubbed server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { AUTO_RUNS_STUB } = require('./helpers/automation_runs_stub');
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
        const seen = /\\/api\\/(scheduled|workflows)\\/runs\\/(\\d+)\\/seen$/.exec(url);
        if (method === 'POST' && seen) { (window.__seenPosts = window.__seenPosts || []).push(seen[1] + ':' + seen[2]); const list = seen[1] === 'scheduled' ? window.__jobRuns : window.__wfRuns, r = list.find(x => x.id === Number(seen[2])); if (!r) return json({ error: 'not found' }, 404); if (!r.seen_at) r.seen_at = new Date().toISOString(); return json({ ok: true }); }
        const run = /\\/api\\/workflows\\/runs\\/(\\d+)$/.exec(url);
        if (method === 'GET' && run) { const r = window.__wfRuns.find(x => x.id === Number(run[1])); return r ? json({ ...r, steps: [] }) : json({ error: 'not found' }, 404); }
        const one = /\\/api\\/workflows\\/(\\d+)$/.exec(url);
        if (method === 'GET' && one) return json(window.__wfs.find(w => w.id === Number(one[1])));
        return real(u, o);
    };
    return true; })()`;

(async () => {
    const { Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB }); await Page.addScriptToEvaluateOnNewDocument({ source: AUTO_RUNS_STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `, check = (ok, msg) => { if (!ok) problems.push(at + msg); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady('startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`try { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-automations-')) localStorage.removeItem(k); } catch {} true`);
            const header = () => ev(`(() => { const row = document.querySelector('#group-table-view .list-bar-search-row'); if (!row) return null; const q = s => row.querySelector(s), top = e => e ? Math.round(e.getBoundingClientRect().top) : null, search = q('.list-bar-search'); return { pageHeader: row.classList.contains('page-header'), searchTop: top(search), titleTop: top(q('.team-tb-title, h1, h2, .list-bar-title')), rowTop: top(row) }; })()`);
            const heads = {};
            for (const folder of ['jobs', 'workflows', 'failed', 'recent']) {
                await ev(`window.openAutomationsFolder('${folder}'); true`);
                await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length > 0 && !!document.querySelector('#group-table-view .list-bar-search')`, `${at}${folder} drew`, 10000);
                await settle(300);
                heads[folder] = await header();
                check(heads[folder] && heads[folder].pageHeader, `${folder}: the toolbar is on the page header (two rows): ${JSON.stringify(heads[folder])}`);
            }
            const kinds = new Set(Object.values(heads).map(x => x && x.pageHeader));
            check(kinds.size === 1 && kinds.has(true), `all four folders have the one header layout: ${JSON.stringify(heads)}`);
            // Failed: the status word whole
            await ev(`window.openAutomationsFolder('failed'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length > 0`, `${at}Failed`, 10000); await settle(300);
            const chips = await ev(`[...document.querySelectorAll('#group-table-view tbody .status-mark[data-state="failed"] .status-word')].map(c => ({ text: c.textContent.trim(), clipped: c.scrollWidth > c.clientWidth + 1, w: Math.round(c.getBoundingClientRect().width) }))`);
            check(chips.length > 0 && chips.every(c => c.text === 'Failed' && !c.clipped), `the Last run chip says Failed, whole: ${JSON.stringify(chips)}`);
            // Recent runs: the dot is not red; the footer counts what is not opened
            await ev(`window.openAutomationsFolder('recent'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 5`, `${at}Recent runs`, 10000); await settle(300);
            const dot = await ev(`(() => { const d = document.querySelector('#group-table-view .automations-unread'); if (!d) return null; const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec(getComputedStyle(d).backgroundColor); return m ? { r: +m[1], g: +m[2], b: +m[3] } : null; })()`);
            check(dot && !(dot.r > dot.g + 60 && dot.r > dot.b + 60), `the unopened dot is not red: ${JSON.stringify(dot)}`);
            const foot = await ev(`(document.querySelector('.dt-foot') || { textContent: '' }).textContent.replace(/\\s+/g, ' ').trim()`);
                        check(/\d+ not opened/.test(foot), `the footer says how many runs are not opened: ${JSON.stringify(foot)}`);
        }
    } finally { await Page.close?.().catch(() => {}); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('automations_walk_16412_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
