// Automations, the Jobs folder (Goal #74, UI/UX #8862): Workflows and Jobs as one screen built like the Inbox. The sidebar holds a folder (Jobs, with its count), not rows; the folder's page is one table on the shared
// list toolbar (the search named "Search jobs", the All / Active / Paused pills with counts, the Filters icon with Result, Runs, Agent and Sort, "New job" at the right); a row says what the job runs under its name; a row
// opens the job in place at /automations/jobs/<id> with a way back to the folder that returns the keyboard to that row; /jobs and a job's link open the same places. 1280 and 390 px, a stubbed server.
// Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const { oneLinePerRow } = require('./helpers/row_lines');
const BASE = require('./test_base').BASE;

(async () => {
    const { Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page, 'automations-jobs'); // the scenes UI/UX looks at: the folder and a job's page, at both widths in both themes (written when the gate asks for shots)
    const themed = async (name, w) => { for (const theme of ['dark', 'light']) { await setTheme(ev, theme); await settle(150); await shot(`${name}-${theme}-${w}`); } await setTheme(ev, 'dark'); };
    const { settle } = require('./helpers/wait').bind(ev);
    const STUB = `(() => {
        const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        const ago = h => new Date(Date.now() - h * 3600000).toISOString(), inn = h => new Date(Date.now() + h * 3600000).toISOString();
        const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/project', base_branch: 'main', prompt: '', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', consecutive_failures: 0 };
        const jobs = [
            { ...base, id: 1, name: 'nightly-build-job', cron_expr: '0 2 * * *', workflow_id: 7, next_fire_at: inn(20), consecutive_failures: 1, last_run: { id: 11, status: 'failed', error_msg: 'step 1 (Test) failed: exit code 3', started_at: ago(8), finished_at: ago(8) } },
            { ...base, id: 2, name: 'summarize-the-day', cron_expr: '0 18 * * 1-5', prompt: 'Summarize what changed today.', next_fire_at: inn(30), last_run: { id: 12, status: 'completed', started_at: ago(5), finished_at: ago(5) } },
            { ...base, id: 3, name: 'weekly-cleanup', cron_expr: '0 9 * * 1', prompt: 'Tidy.', enabled: 0, next_fire_at: null, last_run: null },
        ];
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (method === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs });
            if (/\\/api\\/scheduled\\/jobs\\/(\\d+)\\/runs/.test(url)) return json({ runs: [], total: 0 });
            if (method === 'GET' && /\\/api\\/workflows$/.test(url)) return json({ workflows: [{ id: 7, name: 'nightly-build', steps: [{ name: 'Install' }, { name: 'Test' }] }] });
            if (method === 'GET' && /\\/api\\/workflows\\/7\\/runs/.test(url)) return json({ runs: [], total: 0 });
            return real(u, o);
        };
        return true; })()`;
    const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
    const names = () => ev(`[...document.querySelectorAll('#group-table-view button.dt-primary')].map(b => b.textContent.trim())`);
    const pathname = () => ev(`location.pathname`);
    const pick = pattern => ev(`[...document.querySelectorAll('#group-table-view .team-tb-pills .goals-chip')].find(b => ${pattern}.test(b.textContent.trim())).click(); true`);
    const setField = (id, value) => ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`try { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-automations-')) localStorage.removeItem(k); } catch {} true`);
            await ev(`document.getElementById('nav-tab-automations').click(); true`); // the tab's own click (its action must know the tab), not the page function
            await waitFor(`document.querySelectorAll('#group-table-view button.dt-primary').length === 3`, `${at}the three jobs in the folder's table`, 10000);
            assert.equal(await pathname(), '/automations/jobs', `${at}the address is the folder's`);
            // the next run's exact time is text too, not only a tooltip (#9117): the two jobs with a next run say it for a screen reader; the paused one has none
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => (r.querySelector('td[data-key=next] .sr-only') || {}).textContent || '')`).then(a => a.map(t => /^, next run .+ your time$/.test(t))), [true, true, false], `${at}the next run is also text for assistive technology`);
            const folderWords = mobile ? `[...document.querySelectorAll('#group-table-view .view-list-select option')].map(o => o.textContent.trim())` : `[...document.querySelectorAll('.view-list-item')].map(b => b.textContent.trim().replace(/\\s+/g, ' '))`;
            assert.deepEqual(await ev(folderWords), mobile ? ['Running now (0)', 'Failed (1)', 'Jobs (3)', 'Workflows (1)'] : ['Running now0', 'Failed1', 'Jobs3', 'Workflows1'], `${at}the folders with their counts, not job rows`);
            assert.equal(await ev(`document.querySelectorAll('#automations-nav-list .sched-row').length`), 0, `${at}no job rows in the sidebar`);
            assert.deepEqual(await names(), ['nightly-build-job', 'summarize-the-day', 'weekly-cleanup'], `${at}by next run (20 h, 30 h), the paused job last`);
            // the Last run chip says its state in words (the old sidebar dot's name, which scheduler_status_dot pinned): the words are the chip's text, the dot is decoration
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(r => [r.querySelector('.dt-primary').textContent, [...r.querySelectorAll('.dt-chip')].map(c => c.textContent.trim()), r.querySelectorAll('.dt-chip .goal-dot[aria-hidden="true"]').length])`), [['nightly-build-job', ['last run failed'], 1], ['summarize-the-day', ['last run passed'], 1], ['weekly-cleanup', ['Paused'], 1]], `${at}each Last run chip is named by its words (failed, passed, Paused), its dot decorative`);
            await oneLinePerRow(ev, '#group-table-view tbody tr[data-key]', `${at}the jobs`, assert, { min: 3 }); // Goal #79: one line a row at both widths; a narrow list drops Schedule and Next
            const tips = await ev(`[...document.querySelectorAll('#group-table-view button.dt-primary')].map(b => b.title).sort()`);
            assert.deepEqual(tips, ['nightly-build-job \u2014 Workflow nightly-build', 'summarize-the-day \u2014 Agent prompt (Claude)', 'weekly-cleanup \u2014 Agent prompt (Claude)'], `${at}what a job runs is its name's tooltip (and its page's), not a second line`);
            assert.equal(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].some(r => [...r.querySelectorAll('.dt-subtitle')].length)`), false, `${at}no row has a subtitle line`);
            assert.equal(await ev(`document.querySelector('#group-table-view .list-bar-search').getAttribute('aria-label')`), 'Search jobs', `${at}the search is named for the folder`);
            assert.equal(await ev(`/New job/.test((document.querySelector('#group-table-view .team-tb-action') || {}).textContent || '')`), true, `${at}New job is at the row's right`);
            const act = await ev(`(() => { const b = document.querySelector('#group-table-view .team-tb-action'), r = b.getBoundingClientRect(); return { name: b.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height), text: [...b.querySelectorAll('.automations-act-text')].some(e => e.getClientRects().length > 0) }; })()`);
            assert.equal(act.name, 'New job', `${at}the create action is named whole: ${JSON.stringify(act)}`);
            if (mobile) assert.ok(act.w >= 44 && act.h >= 44 && !act.text, `${at}on a phone it is one 44 px "+", the words only for assistive technology: ${JSON.stringify(act)}`);
            else assert.ok(act.text, `${at}at 1280 it has its words: ${JSON.stringify(act)}`);
            if (!mobile) assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view .team-tb-pills .goals-chip')].map(b => b.textContent.trim().replace(/\\s+/g, ' '))`), ['All 3', 'Active 2', 'Paused 1'], `${at}the pills have the table's counts`);

            // the Filters panel
            await ev(`document.querySelector('#group-table-view .list-bar-toggle').click(); true`); await settle(200);
            const labels = await ev(`[...document.querySelectorAll('#group-table-view .list-bar-field-label')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()).join('|')`);
            assert.match(labels, /Result.*Runs.*Agent.*Sort/, `${at}the Filters panel has Result, Runs, Agent and Sort (${labels})`);
            await setField('automations-jobs-result', 'failed'); await settle(300);
            assert.deepEqual(await names(), ['nightly-build-job'], `${at}Result: Failed leaves the failed job`);
            await setField('automations-jobs-result', ''); await settle(300);
            await ev(`document.querySelector('#group-table-view .list-bar-toggle').click(); true`); await settle(200);
            if (!mobile) {
                await pick(/Paused/); await settle(300);
                assert.deepEqual(await names(), ['weekly-cleanup'], `${at}the Paused pill leaves the paused job`);
                await pick(/^All/); await settle(300);
            }

            await themed('folder', w);
            // a row opens the job in place; the way back returns to the folder and to the row
            await ev(`[...document.querySelectorAll('#group-table-view button.dt-primary')].find(b => b.textContent.trim() === 'summarize-the-day').click(); true`);
            await waitFor(`!!document.querySelector('#scheduler-detail .sched-header')`, `${at}the job's page`, 8000);
            assert.equal(await pathname(), '/automations/jobs/2', `${at}the address is the job's`);
            assert.equal(await ev(`document.querySelector('#scheduler-detail .sched-header h2').textContent`), 'summarize-the-day');
            await themed('job-page', w);
            assert.equal(await ev(`!!document.querySelector('#scheduler-detail [data-on-click="automations-back"]')`), true, `${at}the page has its way back to the folder`);
            await ev(`[...document.querySelectorAll('#scheduler-detail [data-on-click="automations-back"]')].find(b => b.getClientRects().length).click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view button.dt-primary').length === 3 && document.getElementById('group-table-view').getClientRects().length > 0`, `${at}back at the folder's table`, 8000);
            assert.equal(await pathname(), '/automations/jobs', `${at}Back is the folder's address`);
            assert.equal(await ev(`document.activeElement && document.activeElement.textContent.trim()`), 'summarize-the-day', `${at}the keyboard is back on the row the job came from`);

            // addresses
            await Page.navigate({ url: BASE + '/automations/jobs/1' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await waitFor(`!!document.querySelector('#scheduler-detail .sched-header')`, `${at}a job's address opens its page`, 10000);
            assert.equal(await ev(`document.querySelector('#scheduler-detail .sched-header h2').textContent`), 'nightly-build-job');
            await Page.navigate({ url: BASE + '/jobs' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await waitFor(`location.pathname === '/automations/jobs' && document.querySelectorAll('#group-table-view button.dt-primary').length === 3`, `${at}/jobs opens the Jobs folder`, 10000);
            assert.equal(await ev(vis('#scheduler-detail .sched-header')), false, `${at}and no job's page`);
            assert.equal(await ev(`document.documentElement.scrollWidth <= window.innerWidth`), true, `${at}nothing wider than the screen`);
            console.log(`${at}ok`);
        }
        console.log('automations_jobs_browser: ok');
        process.exit(0);
    } catch (e) { console.error(e); process.exit(1); }
})();
