// Workflows on the shared sidebar (#7471, part 2 of one sidebar, UI/UX's audit c2596330): the pane has the header's parts in the same pixels as the other tabs (search "Search workflows", no Display
// options, Expand or collapse all, Hide), the groups Active and Paused (a workflow that is switched off), and "+ New workflow" pinned under the list; a group's name opens a table at 20/700 with its count and the columns
// Workflow, Steps, Last run, Result, Run (a Run button per row, named for its workflow) with Build with Agent in its head; a workflow's page has its link back, a 17/700 name, one facts line, Steps and Runs as tables,
// and a bar pinned at the foot (More, Edit with Agent, Edit, Run as the primary); a run's page has its link back to the workflow and a bar (Re-run); with no workflow the page is one empty line with its hint and
// Build with Agent; the search narrows the list; both themes and 200% text; a phone's list is the page and a workflow the screen after it. Drives Chrome over CDP through agent_view_harness.js, stubbed API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme, auditRegion } = require('./helpers/contrast');
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
    { id: 2, workflow_id: 1, status: 'failed', trigger_type: 'schedule', started_at: iso(3700000), finished_at: iso(3600000), duration_seconds: 100, failed_step: { number: 2, name: 'Test' }, failure_reason: 'exit code 3' },
    { id: 1, workflow_id: 1, status: 'completed', trigger_type: 'manual', started_at: iso(90000000), finished_at: iso(89990000), duration_seconds: 10 },
];
const RUN2 = { id: 2, workflow_id: 1, workflow_name: 'nightly-build', status: 'failed', trigger_type: 'schedule', started_at: iso(3700000), finished_at: iso(3600000),
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
    const pane = tab => `.sidebar-pane[data-pane="${tab}"]`;
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })()`);
    const ON_SCALE = `(root, sizes) => { const want = getComputedStyle(document.body).fontFamily, out = [];
        for (const e of root.querySelectorAll('*')) { if (!e.getClientRects().length || e.matches('.material-icons, .sr-only, pre, code, svg, svg *') || e.closest('pre, code')) continue;
            if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
            const c = getComputedStyle(e), px = parseFloat(c.fontSize); const label = e.tagName + '.' + e.className + ' "' + e.textContent.trim().slice(0, 24) + '" ' + c.fontSize + '/' + c.fontWeight;
            if (c.fontFamily !== want) out.push('family ' + label); else if (!sizes.includes(px)) out.push('size ' + label); else if (!['400', '500', '600', '700'].includes(c.fontWeight)) out.push('weight ' + label); }
        return out; }`;
    const SCALE = '[11, 12, 13, 14, 17, 20]';
    const openTab = async tab => {
        await ev(`window.switchNavTab(${JSON.stringify(tab)}); true`);
        await waitFor(`!document.querySelector('${pane(tab)}').hidden`, `the ${tab} pane`, 8000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [1024, 768, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.clear(); window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);

            await openTab('workflows');
            await waitFor(`document.querySelectorAll('${pane('workflows')} .sgroup-header').length === 2 && document.querySelectorAll('${pane('workflows')} li .row-btn').length === 3`, at + 'the groups and the workflows', 10000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('${pane('workflows')} .sgroup-header .group-name-text')].map(e => e.textContent)`), ['Active', 'Paused'], at + 'Active and Paused');
            assert.deepEqual(await ev(`[...document.querySelectorAll('${pane('workflows')} .sgroup-header .session-group-count')].map(e => e.textContent)`), ['2', '1'], at + 'with their counts');
            // UI/UX's #7588 item 2: a workflow's row has the dot a job's row has (the same slot, the same colour for the same state), and the names start at one left edge
            assert.deepEqual(await ev(`(() => { const rows = [...document.querySelectorAll('${pane('workflows')} li.wf-nav-row')]; const probe = document.createElement('span'); probe.className = 'sched-dot sched-dot-bad'; document.body.append(probe); const bad = getComputedStyle(probe).backgroundColor; probe.remove();
                const dots = rows.map(r => r.querySelector('.sched-dot')); return { all: dots.every(Boolean), failed: rows.filter(r => /Failed/.test(r.textContent)).every(r => getComputedStyle(r.querySelector('.sched-dot')).backgroundColor === bad) && rows.some(r => /Failed/.test(r.textContent)), lefts: [...new Set(rows.map(r => Math.round(r.querySelector('.sched-row-name').getBoundingClientRect().left)))].length }; })()`), { all: true, failed: true, lefts: 1 }, at + 'every workflow row has a dot, a failed one is the red of a failed job, and the names share a left edge');
            // the button is the row: the li around it has no padding and the button is 36 px high (44 on a phone), UI/UX's rule for every sidebar list (#7473)
            assert.deepEqual(await ev(`(() => { const b = document.querySelector('${pane('workflows')} li:not(.session-group-header) > .row-btn'), li = b.parentElement, cs = getComputedStyle(li); return { pad: [cs.paddingTop, cs.paddingBottom], h: Math.round(b.getBoundingClientRect().height) >= ${mobile ? 44 : 36}, same: Math.abs(li.getBoundingClientRect().height - b.getBoundingClientRect().height) <= 1 }; })()`), { pad: ['0px', '0px'], h: true, same: true }, at + 'a row is its button, no padding on the li, at least ${mobile ? 44 : 36} px high');

            assert.equal(await ev(`document.querySelector('${pane('workflows')} .sidebar-search-input').getAttribute('aria-label')`), 'Search workflows', at + 'the search is named for the tab');
            assert.equal(await ev(`!!document.querySelector('${pane('workflows')} [data-display-button]')`), false, at + 'no Display options');
            assert.equal(await ev(`document.querySelector('${pane('workflows')} .sidebar-footer .btn').textContent.trim()`), '+ New workflow', at + '"+ New workflow" is pinned under the list');
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll');
            assert.equal(await ev(`document.getElementById('wf-title') === null || !document.getElementById('wf-title').getClientRects().length`), true, at + 'no page header above the list');

            if (mobile) {
                // the phone's list IS the page; a workflow is the screen after it
                assert.equal(await ev(`!!document.querySelector('#mobile-workflows-list ${pane('workflows')}')`), true, at + 'the pane is in the phone page');
                assert.equal(await ev(`[...document.querySelectorAll('#mobile-workflows-list .sidebar-hide-btn')].some(b => b.getClientRects().length > 0)`), false, at + 'no Hide on a phone');
                assert.equal(await ev(`document.getElementById('wf-page').getClientRects().length`), 0, at + 'the page is not shown until a workflow is chosen');
                await shot(`workflows-one-list-${w}`);
                await ev(`document.querySelector('${pane('workflows')} li .row-btn').click(); true`);
                await waitFor(`document.getElementById('wf-page').getClientRects().length > 0 && !!document.querySelector('#wf-detail .item-bar')`, at + 'the workflow as a screen', 8000);
                assert.equal(await ev(`document.getElementById('mobile-workflows-list').getClientRects().length`), 0, at + 'and the list is not under it');
                assert.equal(await ev(`document.querySelector('#wf-detail .wf-phone-back').textContent.trim()`), '← Back to the list', at + 'with the way back');
                assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, at + 'no sideways scroll on the workflow');
                // the pinned bar is at the foot of the screen and covers none of the page's own content, however long the page is
                const geo = await ev(`(() => { const bar = document.querySelector('#wf-detail .item-bar').getBoundingClientRect(); const under = [...document.querySelectorAll('#wf-detail h3, #wf-detail tbody tr, #wf-detail .wf-facts-line')].filter(e => { const r = e.getBoundingClientRect(); return r.height > 0 && r.top < bar.bottom - 1 && r.bottom > bar.top + 1; }).map(e => e.tagName + ':' + e.textContent.trim().slice(0, 16)); return { vh: innerHeight, bar: [Math.round(bar.top), Math.round(bar.bottom)], under, scrollY: Math.round(scrollY) }; })()`);
                assert.deepEqual(geo.under, [], at + 'the bar covers none of the page: ' + JSON.stringify(geo));
                assert.equal(await ev(`(() => { const bar = document.querySelector('#wf-detail .item-bar'); const last = [...document.querySelectorAll('#wf-detail .wf-runs-section tbody tr')].pop(); return bar.getBoundingClientRect().top >= last.getBoundingClientRect().bottom - 1; })()`), true, at + 'the bar comes after the whole page, runs included');
                assert.equal(await ev(`[...document.querySelectorAll('#wf-detail .wf-steps-section, #wf-detail .wf-runs-section')].every(e => e.scrollHeight <= e.clientHeight + 1 && Math.round(e.getBoundingClientRect().height) >= Math.round(e.lastElementChild.getBoundingClientRect().bottom - e.getBoundingClientRect().top) - 1)`), true, at + "each section holds its own content (none is squeezed under the bar)");
                await shot(`workflows-one-page-${w}`);
                await ev(`document.querySelector('#wf-detail .wf-phone-back').click(); true`);
                await waitFor(`document.getElementById('mobile-workflows-list').getClientRects().length > 0 && document.getElementById('wf-page').getClientRects().length === 0`, at + 'back is the list', 4000);
                continue;
            }

            // the header's parts are in the same pixels as on Agents
            const parts = {};
            for (const tab of ['agents', 'workflows']) { await openTab(tab); parts[tab] = { hide: await rect(`${pane(tab)} .sidebar-hide-btn`), search: await rect(`${pane(tab)} .sidebar-search-input`) }; }
            assert.deepEqual(parts.workflows.hide, parts.agents.hide, at + 'Hide is in the same place as on Agents');
            assert.deepEqual(parts.workflows.search.slice(0, 2), parts.agents.search.slice(0, 2), at + 'the search starts in the same place');
            await openTab('workflows');
            const foot = await ev(`(() => { const r = document.querySelector('${pane('workflows')} .sidebar-footer .btn').getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; })()`);
            assert.equal(foot, true, at + 'the pinned action is on screen');

            // the tab opens on its first group's table
            await waitFor(`!!document.querySelector('#group-table-view table.group-table') && document.getElementById('group-table-view').checkVisibility()`, at + 'the first group as a table', 10000);
            assert.equal(await ev(`document.querySelector('#group-table-title').textContent`), 'Active', at + 'Active first');
            // UI/UX's #7588 item 8: the group head is one fixed row (36 px, 44 on a phone) with a header button or without, so the title is where every other tab has it
            assert.equal(await ev(`(() => { const v = document.getElementById('group-table-view'), t = document.querySelector('#group-table-title').getBoundingClientRect(), h = document.querySelector('#group-table-view .group-table-head').getBoundingClientRect(); const m = innerWidth < 768 || matchMedia('(pointer: coarse)').matches ? 44 : 36;
                return Math.round(h.height) === m && Math.abs(t.top - (v.getBoundingClientRect().top + parseFloat(getComputedStyle(v).paddingTop) + (m - t.height) / 2)) < 1.5; })()`), true, at + 'the title row is one fixed height');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view th')].map(h => [h.textContent, h.getAttribute('scope')])`), [['Workflow', 'col'], ['Steps', 'col'], ['Last run', 'col'], ['Result', 'col'], ['Run', 'col']], at + 'the columns');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => r.children[0].textContent.trim() + '|' + r.children[1].textContent.trim() + '|' + r.children[3].textContent.trim())`), ['nightly-build|2|Failed: step 2 (Test)', 'lint-and-fix|1|Passed'], at + 'a row per workflow: name, steps, result');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#group-table-view tbody .group-table-cell-btn')].map(b => b.getAttribute('aria-label'))`), ['Run nightly-build', 'Run lint-and-fix'], at + 'a Run button per row, named for its workflow');
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.querySelector('#group-table-title')), c = getComputedStyle(document.querySelector('#group-table-view .group-table-head .session-group-count')); return [t.fontSize, t.fontWeight, c.fontSize, c.fontWeight]; })()`), ['20px', '700', '11px', '600'], at + 'the title is 20/700, its count 11/600');
            assert.match(await ev(`document.querySelector('#group-table-view .group-table-head .group-table-extra').textContent`), /Build with Agent/, at + 'Build with Agent is in the table head');
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('group-table-view'), ${SCALE})`), [], at + 'every text of the table is on the scale');
            assert.equal(await ev(`(() => { const sc = document.querySelector('#group-table-view .group-table-scroll'); return document.documentElement.scrollWidth <= document.documentElement.clientWidth && sc.scrollWidth <= sc.clientWidth + 1; })()`), true, at + 'the table fits the page with no sideways scroll');
            await shot(`workflows-one-table-${w}`);

            // Run in the table: the button says Starting\u2026 and is off until the run exists, then a line says Started <name> and the run's page is open
            await ev(`document.querySelector('#group-table-view tbody .group-table-cell-btn').click(); true`);
            assert.deepEqual(await ev(`(() => { const b = document.querySelector('#group-table-view tbody .group-table-cell-btn'); return [b.textContent.trim(), b.disabled]; })()`), ['Starting\u2026', true], at + 'Run reads Starting\u2026 and is disabled while the run is being made');
            await waitFor(`!!document.querySelector('#wf-run-detail .wf-run-title')`, at + "the run's page", 8000);
            assert.equal(await ev(`document.getElementById('wf-status').textContent`), 'Started nightly-build', at + 'a status line says what started');
            assert.equal(await ev(`(document.querySelector('#wf-run-detail .wf-started-line') || {}).textContent`), 'Started nightly-build', at + "and the run's page shows it");
            await ev(`window.workflowsBackToList(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility() && document.querySelector('#group-table-title').textContent === 'Active'`, at + 'back on the table', 8000);
            // Paused opens its own table; the title does not move
            const t1 = await rect('#group-table-title');
            await ev(`document.querySelector('${pane('workflows')} .sgroup-header[data-group-name="workflows:wf-paused"]').click(); true`);
            await waitFor(`document.querySelector('#group-table-title').textContent === 'Paused'`, at + 'Paused opens its table', 8000);
            const t2 = await rect('#group-table-title');
            assert.deepEqual([t2[0], t2[1], t2[3]], [t1[0], t1[1], t1[3]], at + 'the title does not move from group to group');

            // a workflow's page
            await ev(`document.querySelector('${pane('workflows')} .sgroup-header[data-group-name="workflows:active"]').click(); true`);
            await waitFor(`document.querySelector('#group-table-title').textContent === 'Active'`, at + 'Active again', 8000);
            await ev(`document.querySelector('#group-table-view .group-table-link').click(); true`);
            await waitFor(`!!document.querySelector('#wf-detail .item-bar') && !!document.querySelector('#wf-detail .wf-runs-table tbody tr')`, at + "the workflow's page", 8000);
            assert.equal(await ev(`document.getElementById('wf-back-btn').textContent`), '← Active', at + 'back names the group');
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.getElementById('wf-title')); return [t.fontSize, t.fontWeight]; })()`), ['17px', '700'], at + "the name is 17/700");
            assert.match(await ev(`document.querySelector('#wf-detail .wf-facts-line').textContent`), /^Folder \/work\/app · Time limit .* · Created /, at + 'one facts line under the name');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#wf-detail .wf-steps-table th')].map(h => h.textContent)`), ['Step', 'Type', 'Command'], at + 'Steps are a table');
            assert.equal(await ev(`document.querySelector('#wf-detail .wf-steps-table tbody tr td:nth-child(3) code').textContent`), 'npm ci', at + 'a step\'s command is code');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#wf-detail .wf-runs-table th')].map(h => [h.textContent, h.getAttribute('scope')])`), [['Started', 'col'], ['Result', 'col'], ['Duration', 'col'], ['Trigger', 'col']], at + 'Runs are a table');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#wf-detail .item-bar > .btn, #wf-detail .item-bar > .wf-more > .btn')].filter(b => b.getClientRects().length).map(b => b.textContent.replace(/smart_toy|play_arrow/, '').trim() + (b.classList.contains('btn-primary') ? '*' : ''))`), ['More', 'Edit with Agent', 'Edit', 'Run*'], at + 'the pinned bar: More, Edit with Agent, Edit, Run, the primary last');
            assert.equal(await ev(`(() => { const r = document.querySelector('#wf-detail .item-bar').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.bottom >= innerHeight - 40 && r.top >= 0; })()`), true, at + 'the bar is on screen, at the foot of it');
            // UI/UX's #7588 item 3: a toast sits above the page's pinned bar, never over it (a phone's toasts are at the top, where the bar is not)
            await ev(`import((window.__coralStatic || '/static/') + 'utils.js').then(m => m.showToast('Workflow triggered, run 2')).then(() => true)`);
            await waitFor(`!!document.querySelector('#toast-host > .toast')`, at + 'a toast', 4000);
            assert.equal(await ev(`(() => { const t = document.querySelector('#toast-host > .toast').getBoundingClientRect(), b = document.querySelector('#wf-detail .item-bar').getBoundingClientRect(); return mobileTop() || t.bottom <= b.top + 1; function mobileTop() { return getComputedStyle(document.getElementById('notices')).bottom === 'auto'; } })()`), true, at + 'the toast is above the bar (it hides none of its buttons)');
            await shot(`workflows-one-toast-${w}`);
            assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('wf-detail'), ${SCALE})`), [], at + "every text of the workflow's page is on the scale");
            await shot(`workflows-one-page-${w}`);

            // a run's page
            await ev(`document.querySelector('#wf-detail .wf-runs-table .row-open-btn').click(); true`);
            await waitFor(`!!document.querySelector('#wf-run-detail .wf-run-title') && !!document.querySelector('#wf-run-detail .item-bar')`, at + "the run's page", 8000);
            assert.equal(await ev(`document.getElementById('wf-run-back').textContent`), '← nightly-build', at + 'back goes to its workflow');
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.querySelector('#wf-run-detail .wf-run-title')); return [t.fontSize, t.fontWeight]; })()`), ['17px', '700'], at + 'Run #2 is 17/700');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#wf-run-detail .item-bar .btn')].map(b => b.textContent.replace(/replay|stop/, '').trim() + (b.classList.contains('btn-primary') ? '*' : ''))`), ['Re-run*'], at + 'the run\'s bar');
            await shot(`workflows-one-run-${w}`);
            await ev(`document.getElementById('wf-run-back').click(); true`);
            await waitFor(`document.getElementById('wf-title') && document.getElementById('wf-title').textContent === 'nightly-build'`, at + 'back is the workflow', 8000);
            await ev(`document.getElementById('wf-back-btn').click(); true`);
            await waitFor(`document.getElementById('group-table-view').checkVisibility()`, at + 'back is the table', 8000);

            // the search narrows the list
            await ev(`(() => { const i = document.querySelector('${pane('workflows')} .sidebar-search-input'); i.value = 'lint'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('${pane('workflows')} li .row-btn').length === 1`, at + 'the search narrows the list', 5000);
            assert.match(await ev(`document.querySelector('${pane('workflows')} li .row-btn').textContent`), /lint-and-fix/, at + 'to the match');
            await ev(`(() => { const i = document.querySelector('${pane('workflows')} .sidebar-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('${pane('workflows')} li .row-btn').length === 3`, at + 'cleared', 5000);

            // no workflow: one empty line, its hint and Build with Agent; creating is the sidebar's
            if (w === 1280) {
                await ev(`window.__wfEmpty = true; window.workflowsBackToList(); true`);
                await waitFor(`document.getElementById('wf-list-container').checkVisibility() && document.querySelectorAll('${pane('workflows')} li .row-btn').length === 0`, at + 'the empty page', 8000);
                assert.deepEqual(await ev(`(() => { const l = getComputedStyle(document.querySelector('#wf-list-empty .empty-line')), h = getComputedStyle(document.querySelector('#wf-list-empty .empty-hint')); return [document.querySelector('#wf-list-empty .empty-line').textContent, l.fontSize, l.fontWeight, h.fontSize, h.fontWeight]; })()`), ['No workflows yet.', '14px', '400', '12px', '400'], at + 'one empty line, 14/400, and a 12/400 hint');
                assert.equal(await ev(`document.getElementById('wf-build-agent-btn').getClientRects().length > 0`), true, at + 'Build with Agent is in the empty page');
                await shot(`workflows-one-empty-${w}`);
                await ev(`window.__wfEmpty = false; window.workflowsBackToList(); true`);
                await waitFor(`document.getElementById('group-table-view').checkVisibility()`, at + 'the table is back', 8000);

                // both themes and 200% text: contrast, inside the screen
                for (const theme of ['dark', 'light']) for (const zoom of ['', '32px']) {
                    const how = at + `${theme}${zoom ? ', 200% text' : ''}: `;
                    await setTheme(ev, theme); await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
                    await ev(`document.querySelector('${pane('workflows')} .sgroup-header').click(); true`);
                    await waitFor(`document.getElementById('group-table-view').checkVisibility()`, how + 'the table', 8000);
                    const au = await auditRegion(ev, ['.sidebar', '#group-table-view']);
                    assert.deepEqual(au.fails.map(f => `${f.sel} ${f.what} ${f.ratio}`), [], how + 'the sidebar and the table: contrast');
                    await ev(`document.querySelector('#group-table-view .group-table-link').click(); true`);
                    await waitFor(`!!document.querySelector('#wf-detail .item-bar')`, how + 'the workflow', 8000);
                    const au2 = await auditRegion(ev, ['#wf-page']);
                    assert.deepEqual(au2.fails.map(f => `${f.sel} ${f.what} ${f.ratio}`), [], how + "the workflow's page: contrast");
                    assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, how + 'no sideways scroll');
                    const cut = await ev(`[...document.querySelectorAll('#wf-detail .item-bar .btn')].filter(b => b.getClientRects().length && (b.getBoundingClientRect().right > innerWidth || b.getBoundingClientRect().bottom > innerHeight + 1)).length`);
                    assert.equal(cut, 0, how + "the bar's buttons are all on screen");
                }
                await setTheme(ev, 'dark'); await ev(`document.documentElement.style.fontSize = ''; true`);
            }
        }
        console.log('PASS workflows one sidebar: groups, table, workflow and run pages, pinned bars, empty line, search, phone screens');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
