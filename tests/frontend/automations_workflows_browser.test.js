// Automations, the Workflows folder (Goal #74, UI/UX #8862; it carried the Workflows tab's checks from #7471): the sidebar's folder list has Workflows with its count; the folder's page is one table on the shared
// toolbar (the search named "Search workflows", the All / Active / Paused pills with counts, Filters: Result, Step type, Sort, Build with Agent and New workflow at the right) with the columns Workflow, Steps, Last run and
// Used by (no state-changing button in a row: Run is on the workflow's page); a workflow's page has its link back, a 20/700 name, one facts line, Steps and Runs as tables, and a bar pinned at the foot (More, Edit with Agent,
// Edit, Run as the primary); a run's page has its link back to the workflow and a bar (Re-run); with no workflow the folder is one empty line with its hint; /workflows opens the folder; both themes and 200%
// text; a phone's table is the page and a workflow the screen after it. Drives Chrome over CDP through agent_view_harness.js, stubbed API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme, auditRegion } = require('./helpers/contrast');
const { oneLinePerRow } = require('./helpers/row_lines');
const BASE = require('./test_base').BASE;

const now = Date.now();
const iso = ms => new Date(now - ms).toISOString();
const WFS = [
    { id: 1, name: 'nightly-build', description: 'Build and test', enabled: true, step_count: 2, max_duration_s: 3600, repo_path: '/work/app', created_at: iso(86400000 * 3),
        steps: [{ name: 'Install', type: 'shell', command: 'npm ci' }, { name: 'Test', type: 'shell', command: 'npm test -- --ci' }], last_run: { id: 2, status: 'failed', started_at: iso(3600000), failed_step: { number: 2, name: 'Test' } } },
    { id: 2, name: 'lint-and-fix', description: '', enabled: true, step_count: 1, max_duration_s: 3600, repo_path: '/work/app', created_at: iso(86400000 * 2),
        steps: [{ name: 'Lint', type: 'shell', command: 'npm run lint' }], last_run: { id: 3, status: 'completed', started_at: iso(7200000) } },
    { id: 3, name: 'old-deploy', description: '', enabled: false, step_count: 1, max_duration_s: 3600, repo_path: '', created_at: iso(86400000 * 9),
        steps: [{ name: 'Ship', type: 'shell', command: 'make ship' }], last_run: null },
];
const RUNS = [
    { id: 2, workflow_id: 1, status: 'failed', trigger_type: 'schedule', started_at: iso(3700000), finished_at: iso(3600000), error_msg: 'step 1 (Test) failed: exit code 3', duration_seconds: 100, failed_step: { number: 2, name: 'Test' }, failure_reason: 'exit code 3' },
    { id: 1, workflow_id: 1, status: 'completed', trigger_type: 'manual', started_at: iso(90000000), finished_at: iso(89990000), duration_seconds: 10 },
];
const RUN2 = { id: 2, workflow_id: 1, workflow_name: 'nightly-build', status: 'failed', trigger_type: 'schedule', started_at: iso(3700000), finished_at: iso(3600000), error_msg: 'step 1 (Test) failed: exit code 3',
    steps: [{ name: 'Install', type: 'shell', status: 'completed', exit_code: 0, started_at: iso(3700000), finished_at: iso(3690000) }, { name: 'Test', type: 'shell', status: 'failed', exit_code: 3, started_at: iso(3690000), finished_at: iso(3600000), output_tail: 'FAIL src/a.test.js', error_tail: 'exit 3' }] };
const STUB = `(() => { const real = window.fetch; const J = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    window.fetch = (u, o) => { const s = String(u); const get = !(o && o.method && o.method !== 'GET');
        if (get && /\\/api\\/workflows\\/runs\\/2$/.test(s)) return J(${JSON.stringify(RUN2)});
        if (get && /\\/api\\/workflows\\/(\\d+)\\/runs/.test(s)) return J({ runs: /\\/1\\/runs/.test(s) ? ${JSON.stringify(RUNS)} : [] });
        const one = /\\/api\\/workflows\\/(\\d+)$/.exec(s);
        if (get && one) return J(${JSON.stringify(WFS)}.find(w => w.id === Number(one[1])));
        if (get && /\\/api\\/workflows$/.test(s)) return J({ workflows: window.__wfEmpty ? [] : ${JSON.stringify(WFS)} });
        if (!get && /\\/api\\/workflows\\/1\\/trigger$/.test(s)) return new Promise(r => setTimeout(() => r(new Response(JSON.stringify({ run_id: 2 }), { status: 200, headers: { 'Content-Type': 'application/json' } })), 500));
        return real(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const themed = async (name, w) => { for (const theme of ['dark', 'light']) { await setTheme(ev, theme); await shot(`${name}-${theme}-${w}`); } await setTheme(ev, 'dark'); };
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })()`);
    const names = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .dt-primary')].map(b => b.textContent.trim())`);
    const pathname = () => ev(`location.pathname`);
    const pill = pattern => ev(`[...document.querySelectorAll('#group-table-view .team-tb-pills .goals-chip')].find(b => ${pattern}.test(b.textContent.trim())).click(); true`);
    const SCALE = '[11, 12, 13, 14, 17, 20]';
    const ON_SCALE = `(root, sizes) => { const want = getComputedStyle(document.body).fontFamily, out = [];
        for (const e of root.querySelectorAll('*')) { if (!e.getClientRects().length || e.matches('.material-icons, .sr-only, pre, code, svg, svg *') || e.closest('pre, code')) continue;
            if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
            const c = getComputedStyle(e), px = parseFloat(c.fontSize); const label = e.tagName + '.' + e.className + ' "' + e.textContent.trim().slice(0, 24) + '" ' + c.fontSize + '/' + c.fontWeight;
            if (c.fontFamily !== want) out.push('family ' + label); else if (!sizes.includes(px)) out.push('size ' + label); else if (!['400', '500', '600', '700'].includes(c.fontWeight)) out.push('weight ' + label); }
        return out; }`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [1024, 768, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.clear(); window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);

            await ev(`window.openAutomationsFolder('workflows'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 3`, at + 'the three workflows in the folder', 10000);
            assert.equal(await pathname(), '/automations/workflows', at + "the address is the folder's");
            const folderWords = mobile ? `[...document.querySelectorAll('#group-table-view .view-list-select option')].map(o => o.textContent.trim())` : `[...document.querySelectorAll('.view-list-item')].map(b => b.textContent.trim().replace(/\\s+/g, ' '))`;
            assert.deepEqual(await ev(folderWords), mobile ? ['Running now (0)', 'Failed (1)', 'Recent runs (0)', 'Jobs (0)', 'Workflows (3)'] : ['Running now0', 'Failed1', 'Recent runs0', 'Jobs0', 'Workflows3'], at + 'the folder list has Workflows with its count');
            assert.deepEqual(await names(), ['lint-and-fix', 'nightly-build', 'old-deploy'], at + 'by name (a workflow has no next run)');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view table th')].map(h => h.querySelector('.dt-sort > span, .dt-head-text').textContent)`), ['Workflow', 'Steps', 'Last run', 'Used by'], at + 'the columns');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(r => r.querySelector('.dt-primary').textContent + '|' + r.textContent.replace(/\\s+/g, ' '))`).then(a => a.map(x => [x.split('|')[0], /(\d) steps?/.exec(x)[1], /Failed: step 2 \(Test\)|Passed|Never run/.exec(x)[0], /(\d+ jobs?|No jobs)/.exec(x)[0]])), [['lint-and-fix', '1', 'Passed', 'No jobs'], ['nightly-build', '2', 'Failed: step 2 (Test)', 'No jobs'], ['old-deploy', '1', 'Never run', 'No jobs']], at + 'steps, last run and who uses it, per row');
            await oneLinePerRow(ev, '#group-table-view tbody tr[data-key]', `${at}the workflows`, assert, { min: 3 }); // Goal #79: one line a row; the description is the name's tooltip, a narrow list drops Steps and Used by
            assert.equal(await ev(`document.querySelectorAll('#group-table-view tbody .dt-action').length`), 0, at + 'no state-changing button in a row: Run is on the workflow\'s page (UI/UX #8863)');
            assert.equal(await ev(`document.querySelector('#group-table-view .list-bar-search').getAttribute('aria-label')`), 'Search workflows', at + 'the search is named for the folder');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view .team-tb-action .btn')].map(b => b.textContent.replace('smart_toy', '').trim())`), ['Build with Agent', 'New workflow'], at + 'Build with Agent and New workflow are the create actions');
            if (!mobile) assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view .team-tb-pills .goals-chip')].map(b => b.textContent.trim().replace(/\\s+/g, ' '))`), ['All 3', 'Active 2', 'Turned off 1'], at + 'the pills have the table\'s counts');
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('group-table-view'), ${SCALE})`), [], at + 'every text of the table is on the scale');
            await themed('automations-workflows-table', w);

            // the toolbar: pills, Filters, search
            if (!mobile) {
                await pill(/Turned off/); await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 1`, at + 'Paused', 4000);
                assert.deepEqual(await names(), ['old-deploy'], at + 'the Paused pill leaves the paused workflow');
                await pill(/^All/); await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 3`, at + 'All', 4000);
            }
            await ev(`document.querySelector('#group-table-view .list-bar-toggle').click(); true`);
            const labels = await ev(`[...document.querySelectorAll('#group-table-view .list-bar-field-label')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()).join('|')`);
            assert.match(labels, /Result.*Step type.*Sort/, at + `the Filters panel has Result, Step type and Sort (${labels})`);
            await ev(`(() => { const s = document.getElementById('automations-workflows-result'); s.value = 'failed'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 1`, at + 'Result: Failed', 4000);
            assert.deepEqual(await names(), ['nightly-build'], at + 'Result: Failed leaves the failed workflow');
            await ev(`(() => { const s = document.getElementById('automations-workflows-result'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 3`, at + 'cleared', 4000);
            await ev(`document.querySelector('#group-table-view .list-bar-toggle').click(); true`);
            await ev(`(() => { const s = document.getElementById('automations-search'); s.value = 'lint'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 1`, at + 'the sidebar search narrows the table', 5000);
            assert.deepEqual(await names(), ['lint-and-fix'], at + 'to the match');
            assert.equal(await ev(`document.querySelector('#group-table-view .list-bar-search').value`), 'lint', at + "and the page's box shows the same words");
            await ev(`(() => { const s = document.getElementById('automations-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 3`, at + 'cleared', 5000);

            // Run on the workflow's page: the button says Starting\u2026 and is off until the run exists, then a line says Started <name> and the run's page is open
            await ev(`[...document.querySelectorAll('#group-table-view button.dt-primary')].find(b => b.textContent.trim() === 'nightly-build').click(); true`);
            await waitFor(`!!document.querySelector('#wf-detail .item-bar [data-on-click="wf-trigger"]')`, at + "the workflow's page", 8000);
            await ev(`document.querySelector('#wf-detail .item-bar [data-on-click="wf-trigger"]').click(); true`);
            assert.deepEqual(await ev(`(() => { const b = document.querySelector('#wf-detail .item-bar [data-on-click="wf-trigger"]'); return [b.textContent.trim(), b.disabled]; })()`), ['Starting\u2026', true], at + 'Run reads Starting\u2026 and is disabled while the run is being made');
            await waitFor(`!!document.querySelector('#wf-run-detail .wf-run-title')`, at + "the run's page", 8000);
            assert.equal(await ev(`document.getElementById('wf-status').textContent`), 'Started nightly-build', at + 'a status line says what started');
            assert.equal(await ev(`document.querySelector('#wf-run-detail .wf-run-title').textContent`), 'nightly-build, run #2', at + "the run's title names the workflow and the run (#9294)");
            assert.equal(await ev(`!!document.querySelector('#wf-run-detail .wf-started-line')`), false, at + "no 'Started <name>' line under the title: the title says it");
            { const meta = await ev(`[...document.querySelectorAll('#wf-run-detail .wf-run-meta > span')].map(s => s.textContent.replace(/\\s+/g, ' ').trim())`);
              assert.equal(meta[0], 'failed', at + 'the state'); assert.equal(meta[1], 'On schedule', at + 'how it started, in words, not the code'); assert.match(meta[2], /^Started .+, took 2 min$/, at + 'one line: when it started and how long it took: ' + meta[2]);
              assert.match(meta[3].replace(/^error /, ''), /^Step 2 \(Test\) exited with 3/, at + 'the failure line is in the Jobs pages\' words: ' + meta[3]); assert.doesNotMatch(meta[3], / :/, at + 'no stray space before the colon'); }
            assert.equal(await pathname(), '/automations/workflows/1/runs/2', at + "the address is the run's");
            await ev(`window.workflowsBackToList(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility() && document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 3`, at + 'back on the table', 8000);
            assert.equal(await pathname(), '/automations/workflows', at + "Back is the folder's address");

            // a workflow's page
            await ev(`[...document.querySelectorAll('#group-table-view button.dt-primary')].find(b => b.textContent.trim() === 'nightly-build').click(); true`);
            await waitFor(`!!document.querySelector('#wf-detail .item-bar') && !!document.querySelector('#wf-detail .wf-runs-table tbody tr')`, at + "the workflow's page", 8000);
            assert.equal(await pathname(), '/automations/workflows/1', at + "the address is the workflow's");
            if (mobile) {
                assert.equal(await ev(`document.getElementById('group-table-view').getClientRects().length`), 0, at + 'the table is not under the workflow screen');
                assert.equal(await ev(`document.querySelector('#wf-detail .wf-phone-back').textContent.trim()`), '\u2190 Workflows', at + 'with the way back');
            } else assert.equal(await ev(`document.getElementById('wf-back-btn').textContent`), '\u2190 Workflows', at + 'back names the folder');
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.getElementById('wf-title')); return [t.fontSize, t.fontWeight]; })()`), ['20px', '700'], at + 'the name is 20/700 (the 20 px title step, #9207)');
            assert.match(await ev(`[...document.querySelectorAll('#wf-detail .wf-facts dt, #wf-detail .wf-facts dd')].map(e => e.textContent.trim()).join('|')`), /^Folder\|\/work\/app\|Time limit\|.+\|Created\|/, at + 'the facts list under the name, as the job page has it (#9458)');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#wf-detail .wf-steps-table th')].map(h => h.textContent)`), ['Step', 'Type', 'Command'], at + 'Steps are a table');
            await oneLinePerRow(ev, '#wf-detail .wf-steps-table tbody tr', `${at}the steps`, assert, { min: 2 }); // Goal #79: a step and a run are one line at both widths; a long command is cut with an ellipsis, a narrow list drops Type
            await oneLinePerRow(ev, '#wf-detail .wf-runs-table tbody tr', `${at}the runs`, assert, { min: 2 });
            assert.equal(await ev(`document.querySelector('#wf-detail .wf-steps-table tbody tr td:nth-child(3) code').textContent`), 'npm ci', at + "a step's command is code");
            assert.deepEqual(await ev(`[...document.querySelectorAll('#wf-detail .wf-runs-table th')].map(h => [h.textContent, h.getAttribute('scope')])`), [['Started', 'col'], ['Result', 'col'], ['Duration', 'col'], ['Trigger', 'col']], at + 'Runs are a table');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#wf-detail .item-bar > .btn, #wf-detail .item-bar > .wf-more > .btn')].filter(b => b.getClientRects().length).map(b => b.textContent.replace(/smart_toy|play_arrow/, '').trim() + (b.classList.contains('btn-primary') ? '*' : ''))`), ['More', 'Edit with Agent', 'Edit', 'Run*'], at + 'the pinned bar: More, Edit with Agent, Edit, Run, the primary last');
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, at + 'no sideways scroll on the workflow');
            assert.equal(await ev(`(() => { const r = document.querySelector('#wf-detail .item-bar').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= 0; })()`), true, at + 'the bar is on screen without scrolling');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('wf-detail'), ${SCALE})`), [], at + "every text of the workflow's page is on the scale");
            assert.equal(await ev(`(() => { const hs = [...document.querySelectorAll('#wf-detail .wf-steps-section h3, #wf-detail .wf-runs-section h3')], p = document.createElement('i'); p.style.color = 'var(--text-secondary)'; document.body.append(p); const want = getComputedStyle(p).color; p.remove(); return hs.length === 2 && hs.every(h => h.classList.contains('group-head-lg') && getComputedStyle(h).color === want && getComputedStyle(h).fontWeight === '600'); })()`), true, at + "the Steps and Runs headings are the shared group head (14/600, the secondary colour) as Analytics' section headings are (#9458)");
            await ev(`document.querySelectorAll('#toast-host > .toast').forEach(t => t.remove()); true`); await themed('automations-workflows-page', w);

            // a run's page
            await ev(`document.querySelector('#wf-detail .wf-runs-table .dt-primary').click(); true`);
            await waitFor(`!!document.querySelector('#wf-run-detail .wf-run-title') && !!document.querySelector('#wf-run-detail .item-bar')`, at + "the run's page", 8000);
            assert.equal(await pathname(), '/automations/workflows/1/runs/2', at + "the address is the run's");
            assert.equal(await ev(`document.getElementById('wf-run-back').textContent`), '\u2190 nightly-build', at + 'back goes to its workflow');
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.querySelector('#wf-run-detail .wf-run-title')); return [t.fontSize, t.fontWeight]; })()`), ['20px', '700'], at + 'Run #2 is 20/700');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#wf-run-detail .item-bar .btn')].map(b => b.textContent.replace(/replay|stop/, '').trim() + (b.classList.contains('btn-primary') ? '*' : ''))`), ['Re-run*'], at + "the run's bar");
            await ev(`document.querySelectorAll('#toast-host > .toast').forEach(t => t.remove()); true`); await themed('automations-workflows-run', w);
            await ev(`document.getElementById('wf-run-back').click(); true`);
            await waitFor(`document.getElementById('wf-title') && document.getElementById('wf-title').textContent === 'nightly-build'`, at + 'back is the workflow', 8000);
            await ev(`[...document.querySelectorAll('#wf-detail [data-on-click="automations-back"]')].find(b => b.getClientRects().length).click(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility() && document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 3`, at + 'back is the table', 8000);
            assert.equal(await ev(`document.activeElement && document.activeElement.textContent.trim()`), 'nightly-build', at + 'with the keyboard on the row the workflow came from');

            // addresses: a workflow's, a run's, and the old ones
            await Page.navigate({ url: BASE + '/automations/workflows/1/runs/2' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await waitFor(`!!document.querySelector('#wf-run-detail .wf-run-title')`, at + "a run's address opens its page", 10000);
            await Page.navigate({ url: BASE + '/workflows/1' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await waitFor(`location.pathname === '/automations/workflows/1' && !!document.querySelector('#wf-detail .item-bar')`, at + '/workflows/1 opens the workflow in Automations', 10000);
            await Page.navigate({ url: BASE + '/workflows' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await waitFor(`location.pathname === '/automations/workflows' && document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 3`, at + '/workflows opens the Workflows folder', 10000);

            // no workflow on a phone: the same one line, its hint and the toolbar's actions (a shot for UI/UX)
            if (mobile) {
                await ev(`window.__wfEmpty = true; import((window.__coralStatic || '/static/') + 'workflows.js').then(m => m.refreshWorkflows()).then(() => true)`);
                await waitFor(`!!document.querySelector('#group-table-view .empty-state .empty-state-line') && document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 0`, at + 'the empty folder on a phone', 8000);
                for (const theme of ['dark', 'light']) { await setTheme(ev, theme); await shot(`automations-workflows-empty-${theme}-${w}`); }
                await setTheme(ev, 'dark');
                await ev(`window.__wfEmpty = false; import((window.__coralStatic || '/static/') + 'workflows.js').then(m => m.refreshWorkflows()).then(() => true)`);
            }
            // no workflow: one empty line with its hint (the toolbar keeps the create actions)
            if (w === 1280) {
                await ev(`window.__wfEmpty = true; import((window.__coralStatic || '/static/') + 'workflows.js').then(m => m.refreshWorkflows()).then(() => true)`);
                await waitFor(`!!document.querySelector('#group-table-view .empty-state .empty-state-line') && document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 0`, at + 'the empty folder', 8000);
                assert.equal(await ev(`document.querySelector('#group-table-view .empty-state .empty-state-line').textContent`), 'No workflows yet.', at + 'one empty line');
                assert.equal(await ev(`[...document.querySelectorAll('#group-table-view [data-on-click="wf-build-agent"]')].some(b => b.getClientRects().length > 0)`), true, at + 'Build with Agent is on the toolbar');
                await shot(`automations-workflows-empty-${w}`);
                await ev(`window.__wfEmpty = false; import((window.__coralStatic || '/static/') + 'workflows.js').then(m => m.refreshWorkflows()).then(() => true)`);
                await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 3`, at + 'the table is back', 8000);

                // both themes and 200% text: contrast, inside the screen
                for (const theme of ['dark', 'light']) for (const zoom of ['', '32px']) {
                    const how = at + `${theme}${zoom ? ', 200% text' : ''}: `;
                    await setTheme(ev, theme); await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
                    const au = await auditRegion(ev, ['.sidebar', '#group-table-view']);
                    assert.deepEqual(au.fails.map(f => `${f.sel} ${f.what} ${f.ratio}`), [], how + 'the sidebar and the table: contrast');
                    await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`);
                    await waitFor(`!!document.querySelector('#wf-detail .item-bar')`, how + 'the workflow', 8000);
                    const au2 = await auditRegion(ev, ['#wf-page']);
                    assert.deepEqual(au2.fails.map(f => `${f.sel} ${f.what} ${f.ratio}`), [], how + "the workflow's page: contrast");
                    assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, how + 'no sideways scroll');
                    const cut = await ev(`[...document.querySelectorAll('#wf-detail .item-bar .btn')].filter(b => b.getClientRects().length && (b.getBoundingClientRect().right > innerWidth || b.getBoundingClientRect().bottom > innerHeight + 1)).length`);
                    assert.equal(cut, 0, how + "the bar's buttons are all on screen");
                    await ev(`[...document.querySelectorAll('#wf-detail [data-on-click="automations-back"]')].find(b => b.getClientRects().length).click(); true`);
                    await waitFor(`document.getElementById('group-table-view').checkVisibility()`, how + 'back at the table', 8000);
                }
                await setTheme(ev, 'dark'); await ev(`document.documentElement.style.fontSize = ''; true`);
            }
        }
        console.log('PASS automations workflows: folder, table, toolbar, Run, workflow and run pages, pinned bars, addresses, empty line, themes and 200% text, phone screens');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
