// The Jobs screen as the #6515 audit asked (findings 1 and 2, #6521): one list of every job with its schedule, last result and next run in words (no "No active jobs" over jobs that exist, a "Running now"
// group only while one runs); and a job page with the failure first, the schedule and the next run in words with their zone, "Does: Workflow <name>", the folder and limits in a closed Settings, the runs
// with their result in words, Delete behind More, no "enabled" pill. 1280 and 390 px, a stubbed server. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTheme } = require('./helpers/contrast');
const SHOT_DIR = process.env.CORAL_SCREENSHOT_DIR || path.join(process.env.RUNNER_TEMP || require('node:os').tmpdir(), 'out', 'shots');
const { connect } = require('./agent_view_harness');
const { assertPinnedBar } = require('./helpers/pinned_bar');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = SHOT_DIR; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const STUB = `(() => {
        const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        const ago = h => new Date(Date.now() - h * 3600000).toISOString(), inn = h => new Date(Date.now() + h * 3600000).toISOString();
        // the next run of a daily "M H * * *" (UTC) job, as the scheduler computes it: the stub's next run follows its cron
        const nextDaily = (m, h) => { const n = new Date(); const t = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), h, m)); if (t <= n) t.setUTCDate(t.getUTCDate() + 1); return t.toISOString(); };
        window.__nextDaily = nextDaily;
        const base = { description: '', timezone: 'UTC', agent_type: 'claude', repo_path: '/work/project', base_branch: 'main', prompt: '', enabled: 1, max_duration_s: 3600, cleanup_worktree: 0, flags: '', job_type: 'workflow', workflow_id: null, created_at: ago(48), updated_at: ago(48), paused_reason: '', consecutive_failures: 0 };
        window.__jobs = [
            { ...base, id: 1, name: 'nightly-build-job', cron_expr: '0 2 * * *', workflow_id: 7, next_fire_at: nextDaily(0, 2), consecutive_failures: 1, last_run: { id: 11, status: 'failed', error_msg: 'step 1 (Test) failed: exit code 3', started_at: ago(8), finished_at: ago(8), scheduled_at: ago(8) } },
            { ...base, id: 2, name: 'summarize-the-day', cron_expr: '0 18 * * 1-5', job_type: 'prompt', prompt: 'Summarize what changed today.', next_fire_at: inn(30), last_run: { id: 12, status: 'completed', started_at: ago(20), finished_at: ago(20), scheduled_at: ago(20) } },
            { ...base, id: 3, name: 'weekly-cleanup', cron_expr: '0 9 * * 1', job_type: 'prompt', prompt: 'Tidy.', enabled: 0, next_fire_at: null, last_run: null },
        ];
        window.fetch = (u, o) => {
            const url = String(u), method = (o && o.method) || 'GET';
            if (method === 'GET' && /\\/api\\/scheduled\\/jobs$/.test(url)) return json({ jobs: window.__jobs });
            let m = /\\/api\\/scheduled\\/jobs\\/(\\d+)\\/runs/.exec(url);
            if (m) return json({ runs: m[1] === '1' ? [{ id: 11, job_id: 1, status: 'failed', error_msg: 'step 1 (Test) failed: exit code 3', started_at: ago(8), finished_at: ago(8), scheduled_at: ago(8) }, { id: 10, job_id: 1, status: 'completed', started_at: ago(32), finished_at: ago(31.9), scheduled_at: ago(32) }] : [] });
            if (method === 'GET' && /\\/api\\/workflows$/.test(url)) return json({ workflows: [{ id: 7, name: 'nightly-build', steps: [{ name: 'Install' }, { name: 'Test' }] }] });
            return real(u, o);
        };
        return true; })()`;
    const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
    const text = sel => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB }); // before the page's own first fetch of the jobs
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px`;
            await Emulation.setTimezoneOverride({ timezoneId: 'America/New_York' }); // the zone is named only when it differs from the viewer's (zoneNote): the jobs are UTC, so the viewer is not, whatever machine runs this (CI's browser is UTC)
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`window.switchNavTab('automations'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 3`, `${at}: the three jobs listed at once`, 8000);

            if (!mobile) {
                await waitFor(`document.querySelectorAll('#group-table-view .dt-chip').length >= 3`, at + 'status chips in group tables', 4000);
                assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view .dt-chip')].map(e => e.textContent)`), ['Failed', 'Passed', 'Paused'], at + 'failed, passed and paused use the shared chips');
                assert.equal(await ev(`document.querySelectorAll('#group-table-view .dt-chip .goal-dot[aria-hidden="true"]').length`), 3, at + 'words convey state; dots are decorative');
                await shot('jobs-state-chips');
            }
            console.log(`${at}: one table, every job, in words`);
            assert.equal(await ev(`document.querySelectorAll('.sidebar-subtab').length`), 0, `${at}: no Active / Scheduled tabs`);
            const running = () => ev(`(document.querySelector('.view-list-item[data-key="running"]') || document.querySelector('.view-list-select option[value="running"]') || {}).textContent.replace(/\\s+/g, ' ').trim()`);
            assert.match(await running(), /^Running now\s*\(?0\)?$/, `${at}: Running now is 0 while nothing runs`);
            await ev(`import(${S} + 'live_jobs.js').then(m => m.renderLiveJobs([{ id: 99, job_id: 2, job_name: 'summarize-the-day', status: 'running', started_at: new Date().toISOString(), session_id: 'abc', agent_type: 'claude', trigger_type: 'cron' }])).then(() => true)`);
            await waitFor(`/1\\)?$/.test((document.querySelector('.view-list-item[data-key="running"]') || document.querySelector('.view-list-select option[value="running"]') || {}).textContent || '')`, `${at}: Running now counts the job that runs`, 4000);
            assert.equal(await text('#live-jobs-status'), '1 job running now', `${at}: said once, politely`);
            await ev(`import(${S} + 'live_jobs.js').then(m => m.renderLiveJobs([])).then(() => true)`);
            assert.match(await running(), /^Running now\s*\(?0\)?$/, `${at}: and 0 again when it ends`);
            assert.equal(await text('#live-jobs-status'), '', `${at}: and cleared when it ends`);
            await shot(`jobs-list-${w}`);

            console.log(`${at}: the job page, failure first`);
            await ev(`document.querySelector('#group-table-view tbody tr[data-key] .dt-primary').click(); true`);
            await waitFor(vis('#scheduler-detail .sched-fail-banner'), `${at}: the job page`, 8000);
            const order = (await ev(`[...document.querySelectorAll('#scheduler-detail > *:not(.sched-back):not(.back-link)')].map(e => e.className.split(' ').filter(c => !/^notice(-|$)/.test(c))[0])`)).filter(c => c !== 'phone-title-row'); // the first class that is not the notice's own: the page's name for the element // the phone's back row (#7121) and the row that holds it with the title (#7734) are not content
            assert.equal(order[0], 'sched-fail-banner', `${at}: the failure is the first thing on the page: ${JSON.stringify(order)}`);
            assert.match(await text('#scheduler-detail .sched-fail-banner'), /The last run failed.*step 2 \(Test\) exited with 3/s);
            assert.equal(await ev(`/\\benabled\\b/i.test(document.querySelector('#scheduler-detail .sched-header').textContent)`), false, `${at}: no "enabled" pill`);
            const facts = await ev(`[...document.querySelectorAll('#scheduler-detail > .sched-facts dt')].map(d => d.textContent.trim() + '=' + d.nextElementSibling.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.equal(facts[0], 'Schedule=Every day at 02:00 (UTC)', `${at}: the schedule row is Schedule, the history below is the only Runs`);
            // Next agrees with the schedule: 02:00 UTC, in this browser's own time (a different zone would show 19:00 in Pacific)
            const expectNext = await ev(`(() => { const t = new Date(window.__nextDaily(0, 2)); const p = n => String(n).padStart(2, '0'); const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); const dd = Math.round((day(t) - day(new Date())) / 86400000); return (dd === 0 ? 'today ' : dd === 1 ? 'tomorrow ' : t.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ') + p(t.getHours()) + ':' + p(t.getMinutes()); })()`);
            assert.equal(facts[1], `Next=${expectNext} your time`, `${at}: Next is the schedule's next 02:00 UTC in the viewer's time`);
            assert.match(facts[1], /^Next=(today|tomorrow|[A-Z][a-z]{2} \d+) \d\d:\d\d your time$/);
            assert.match(await ev(`document.querySelector('#scheduler-detail > .sched-facts dd:nth-of-type(2)').title`), /^in (\d+ h|\d+ min|now)$/, `${at}: the relative part is a title, the absolute time is the text`); // hours, or minutes in the hour before 02:00 UTC (the schedule's own time): the gate failed 01:00 to 02:00Z on /^in \d+ h$/
            assert.equal(facts[2], 'Does=Workflow nightly-build (2 steps)');
            assert.equal(facts[3], 'Folder=/work/project', `${at}: the folder is a fact, not folded away (#9294)`);
            assert.equal(facts.length, 4, `${at}: four facts (Schedule, Next, Does, Folder), the rest is in Settings: ${JSON.stringify(facts)}`);
            assert.doesNotMatch(await ev(`document.querySelector('#scheduler-detail .sched-status-line').textContent`), /next/i, `${at}: the status line does not say the next run twice`);
            assert.equal(await ev(`document.querySelector('#scheduler-detail .sched-settings').open`), false, `${at}: Settings is closed`);
            { const cs = await ev(`(() => { const c = getComputedStyle(document.querySelector('#scheduler-detail .sched-settings > summary')); return [c.display, c.listStyleType, c.listStylePosition]; })()`); assert.ok(cs[0] === 'list-item' || (cs[1] !== 'none'), `${at}: Settings is a disclosure with its arrow (${cs})`); }
            await shot(`jobs-page-closed-${w}`);
            assert.equal(await ev(`/Cleanup|Base branch/.test(document.querySelector('#scheduler-detail .sched-settings').textContent) && !/Cleanup/.test(document.querySelector('#scheduler-detail .sched-settings').textContent)`), false);
            await ev(`document.querySelector('#scheduler-detail .sched-settings > summary').click(); true`);
            assert.match(await text('#scheduler-detail .sched-settings'), /Time limit\s*1 hour/);
            assert.doesNotMatch(await text('#scheduler-detail .sched-settings'), /Folder/, `${at}: the folder left Settings for the facts`);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#scheduler-detail .sched-runs-table th')].map(t => t.textContent.trim())`), ['Started', 'Result', 'Duration', 'Conversation']);
            assert.equal(await ev(`document.querySelector('#scheduler-detail .sched-runs-table th:last-child .sr-only')?.textContent`), 'Conversation', 'the optional conversation column has a screen-reader heading');
            assert.equal(await ev(`document.querySelectorAll('#scheduler-detail .dt-table').length`), 1, 'job history uses the shared table');
            assert.match(await ev(`document.querySelector('#scheduler-detail .sched-runs-table tbody tr').textContent.replace(/\\s+/g, ' ')`), /Failed\s*step 2 \(Test\) exited with 3/);
            assert.match(await ev(`document.querySelectorAll('#scheduler-detail .sched-runs-table tbody tr')[1].textContent.replace(/\\s+/g, ' ')`), /Passed/);

            await assertPinnedBar(ev, '#scheduler-detail .item-bar', `${at}: the job page`);
            assert.equal(await ev(`(() => { const b = document.querySelector('#group-table-view .gt-toolbar'); return !b || (!!b.querySelector('.list-bar-search') && !!b.querySelector('.team-tb-action')); })()`), true, `${at}: the page's toolbar line has the search and New job when the table is on screen (#7723)`);
            console.log(`${at}: Delete is behind More`);
            assert.equal(await ev(vis('#scheduler-detail .sched-delete')), false, `${at}: Delete is not on the page until More opens`);
            await ev(`document.querySelector('#scheduler-detail .sched-more-btn').click(); true`);
            assert.equal(await ev(vis('#scheduler-detail .sched-delete')), true);
            // #9293: an enabled job's primary is Run now; Pause is one of More's items, and More lists Pause before Delete
            assert.equal(await ev(`document.querySelector('#scheduler-detail .sched-actions > .btn-primary')?.textContent.trim()`), 'Run now', `${at}: Run now is the primary`);
            assert.equal(await ev(`document.querySelectorAll('#scheduler-detail .sched-actions > [data-on-click="job-toggle"]').length`), 0, `${at}: no Pause on the bar`);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#scheduler-detail .sched-more-menu .menu-item')].map(b => b.textContent.trim())`), ['Pause', 'Delete'], `${at}: More holds Pause and Delete`);
            assert.equal(await ev(`[...document.querySelectorAll('#scheduler-detail .sched-more-menu .menu-item')].every(b => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })`), true, `${at}: every item of More is on the screen (the menu opens above the pinned bar)`);
            await shot(`jobs-page-more-${w}`);
            await ev(`document.querySelector('#scheduler-detail .sched-more-btn').click(); true`);
            // More closes on an outside click, and when Tab leaves it
            await ev(`document.querySelector('#scheduler-detail .sched-more-btn').click(); true`);
            await ev(`document.querySelector('#scheduler-detail .sched-header h2').click(); true`);
            assert.equal(await ev(vis('#scheduler-detail .sched-delete')), false, `${at}: a click elsewhere closes More`);
            assert.equal(await ev(`document.querySelector('#scheduler-detail .sched-more-btn').getAttribute('aria-expanded')`), 'false');
            await ev(`document.querySelector('#scheduler-detail .sched-more-btn').click(); document.querySelector('#scheduler-detail .sched-delete').focus(); true`);
            for (const type of ['rawKeyDown', 'keyUp']) await client.Input.dispatchKeyEvent({ type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
            await waitFor(`!document.querySelector('#scheduler-detail .sched-more-menu') || document.querySelector('#scheduler-detail .sched-more-menu').hidden`, `${at}: Tab out of More closes it`, 3000);
            assert.equal(await ev(`document.querySelector('#scheduler-detail .sched-more-btn').getAttribute('aria-expanded')`), 'false');
            if (mobile) {
                assert.deepEqual(await ev(`[...document.querySelectorAll('#scheduler-detail .sched-actions .btn')].filter(b => b.getClientRects().length && b.getBoundingClientRect().height < 43.5).length`), 0, `${at}: 44 px targets`);
                assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, `${at}: no sideways scroll`);
            }
            if (mobile) {
                // 200% text: the page does not scroll sideways and nothing on the job page is cut off by the screen's edge
                await ev(`document.documentElement.style.fontSize = '32px'; true`);
                const fit = await ev(`(() => { const r = [...document.querySelectorAll('#scheduler-detail .sched-actions .btn, #scheduler-detail .sched-header h2, #scheduler-detail .sched-facts dd, #scheduler-detail .sched-runs-table')].filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().right)); return { right: Math.max(...r), width: window.innerWidth, scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }; })()`);
                assert.ok(fit.scroll && fit.right <= fit.width + 1, `${at} at 200% text: nothing past the screen edge: ${JSON.stringify(fit)}`);
                await ev(`document.documentElement.style.fontSize = ''; true`);
            }
            await shot(`jobs-page-${w}`);
            await ev(`document.querySelector('#scheduler-detail .sched-settings').open = false; document.querySelector('#scheduler-detail .sched-runs-table').scrollIntoView({ block: 'center' }); true`);
            for (const theme of ['dark', 'light']) {
                await setTheme(ev, theme);
                await shot(`jobs-history-${w}-${theme}`);
            }
            // #9293: a paused job's primary is Enable; Run now is still there, and Pause is not
            await ev(`import(${S} + 'scheduler.js').then(m => m.selectScheduledJob(3)).then(() => true)`);
            await waitFor(`!!document.querySelector('#scheduler-detail .sched-actions')`, `${at}: the paused job's page`, 4000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#scheduler-detail .sched-actions > .btn')].map(b => b.textContent.trim() + (b.classList.contains('btn-primary') ? '*' : ''))`), ['Edit', 'Run now', 'Enable*'], `${at}: paused: Enable is the primary, Run now is there`);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#scheduler-detail .sched-more-menu .menu-item')].map(b => b.textContent.trim())`), ['Delete'], `${at}: a paused job's More holds only Delete`);
            await shot(`jobs-page-paused-${w}`);
        }
        console.log('jobs_screen: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
