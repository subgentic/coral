// The Analytics tab's "Tokens per commit" section (#7526, UI/UX's pace r2): for one team, tokens per landed commit over the last 24 hours against the 7 days before, the usual line, a bar a day, who spends, and how it is counted. Counts come from
// GET /api/board/<team>/spend?range=24h|7d (stubbed here: the page divides); tokens are input plus output with the cache reads beside them; an agent with no token source is "Not measured" in one cell, never zero; the Orchestrator's commits read "team";
// an author that matches no agent is "Unattributed"; no commit is said, not divided by zero. 1280 and 390 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const sceneShots = require('./helpers/scene_shots');
const TEAM = 'coral-go-team';
const FIX = { board: TEAM, range_hours: 24, generated_at: '2026-10-25T10:00:00Z',
    tokens: { window: { input: 2000000, output: 1100000, cache_read: 61000000, cache_write: null }, usual: { input: 6000000, output: 3000000, cache_read: 90000000, cache_write: null } },
    commits: { available: true, repo: 'coral', branch: 'main', window: 6, usual: 25, unattributed: 1, capped: false, queue_landed: {} }, tool_calls: { window: 420, usual: 1500, measured_agents: 3, of_agents: 4 },
    per_day: [0, 1, 2, 3, 4, 5, 6].map(i => ({ day: `2026-10-${19 + i}`, tokens: i === 6 ? 3100000 : 1200000 + i * 20000, commits: i === 2 ? 0 : (i === 6 ? 6 : 3), tool_calls: i === 6 ? 420 : 200 })),
    per_hour: Array.from({ length: 24 }, (_, h) => ({ hour: `2026-10-25T${String(h).padStart(2, '0')}:00:00Z`, tokens: 100000, commits: h % 4 === 0 ? 1 : 0, tool_calls: 30 })),
    task_time: { window: { done: 14, median_s: 2280, p90_s: 7500, wait_median_s: 720, review_median_s: 2820, rounds_mean: 1.6, sent_back: 3 }, usual: { done: 77, median_s: 1860, p90_s: 6000 },
        per_day: [3, 2, 0, 1, 4, 2, 14].map((n, i) => ({ day: `2026-10-${19 + i}`, done: n })), per_hour: Array.from({ length: 24 }, (_, h) => ({ hour: `2026-10-25T${String(h).padStart(2, '0')}:00:00Z`, done: h % 3 === 0 ? 1 : 0 })),
        agents: [{ name: 'Frontend Dev', done: 5, median_s: 3120, sent_back: 2 }, { name: 'Backend Dev', done: 3, median_s: 2040, sent_back: 0 }] },
    agents: [{ name: 'Frontend Dev', role: 'Developer', tokens: 800000, share: 0.26, commits: 2, cache_reads: 14000000, tool_calls: 120, tool_calls_measured: true, measured: true },
        { name: 'Orchestrator', role: 'Orchestrator', orchestrator: true, tokens: 600000, share: 0.19, commits: 0, cache_reads: 12000000, tool_calls: 90, tool_calls_measured: true, measured: true },
        { name: 'Gemini Dev', role: 'Developer', tokens: null, share: null, commits: 2, cache_reads: null, tool_calls: null, tool_calls_measured: false, measured: false },
        { name: 'Unattributed', role: '', tokens: null, share: null, commits: 1, cache_reads: null, tool_calls: null, measured: false }], measured_agents: 3, of_agents: 4 };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const shot = sceneShots(Page, 'analytics-spend');
    const run = async (name, fn) => { try { await fn(); results.push([name, null]); console.log('   ok   ' + name); } catch (e) { results.push([name, e]); console.log('   FAIL ' + name + ': ' + String(e.message).slice(0, 300)); } };
    const text = sel => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { window.__spendReq = []; window.__spendPaths = []; window.__spend = ${JSON.stringify(FIX)}; window.__spendStatus = 200; const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (/\\/api\\/(?:remote\\/[^/]+\\/api\\/)?board\\/[^/]+\\/spend$/.test(url.pathname)) { window.__spendReq.push(url.search); window.__spendPaths.push(url.pathname); return Promise.resolve(new Response(JSON.stringify(window.__spend), { status: window.__spendStatus, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); };
            window._coralSetLiveSessions([{ session_id: 'a-1', name: 'a-1', agent_type: 'claude', board_project: '${TEAM}', display_name: 'Frontend Dev', working_directory: '/tmp/x' }]); return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.querySelectorAll('#cost-spend .spend-card').length >= 5`, 'the section', 10000);
        await run('the headline and the numbers: tokens per commit, usual, commits, cache reads (not in the total), tool calls', async () => {
            assert.equal(await text('#cost-spend .spend-headline'), '517 K tokens per commit, usual 360 K, 44% above.');
            const cards = await ev(`[...document.querySelectorAll('#cost-spend .spend-card')].map(c => c.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.ok(/^517 K\s*tokens per landed commit, 24 h/.test(cards[0]), cards[0]); assert.ok(/^70\s*tool calls per landed commit.*3 of 4 agents measured/.test(cards[1]), cards[1]); assert.ok(/^360 K\s*usual/.test(cards[2]), cards[2]); assert.ok(/^6\s*commits landed on main\s*1 unattributed/.test(cards[3]), cards[3]);
            assert.ok(/^61 M\s*cache reads, not in the total/.test(cards[4]), cards[4]);
            assert.match(await text('#cost-spend .spend-sub'), /Team coral-go-team · last 24 h against the 7 days before/);
        });
        await run('one bar a day, today amber when 30% above usual, the usual line', async () => {
            const b = await ev(`(() => ({ bars: document.querySelectorAll('#cost-spend .spend-bar').length, high: [...document.querySelectorAll('#cost-spend .spend-bar')].map(x => x.classList.contains('spend-bar-high')), usual: !!document.querySelector('#cost-spend .spend-usual'), label: document.querySelector('#cost-spend .spend-bars').getAttribute('aria-label') }))()`);
            assert.equal(b.bars, 6, 'a day with no commit has no bar, not a stub'); assert.deepEqual(b.high, [false, false, false, false, false, true]); assert.equal(b.usual, true); assert.match(b.label, /usual 360 K/);
        });
        await run('who spends: a Not measured note, team for the Orchestrator, an Unattributed row', async () => {
            const t = await ev(`[...document.querySelectorAll('#cost-spend .dt-table tbody tr')].map(r => [...r.children].map(c => c.textContent.trim()))`);
            assert.deepEqual(t[0], ['Frontend Dev', '800 K', '26%', '2', '14 M', '120']); assert.deepEqual(t[1], ['Orchestrator', '600 K', '19%', 'team', '12 M', '90']);
            assert.deepEqual(t[2], ['Gemini DevNot measured', '', '', '', '', '']); assert.deepEqual(t[3], ['UnattributedCommits whose author matches no agent', '', '', '', '', '']); // the note is under the name: no zeros, no dashes in the figure cells
            assert.ok(await ev(`!!document.querySelector('#cost-spend .spend-how')`), 'How it is counted');
            const how = await text('#cost-spend .spend-how');
            assert.match(how, /counts, not proof of who did the work/); assert.match(how, /shared by several teams, Unattributed can include other teams/);
        });
        await run('commits that could not be read are said with their reason, not as zero', async () => {
            await ev(`window.__spend = { ...window.__spend, commits: { available: false, reason: 'no repository found for this team', window: null, usual: null, unattributed: 0 } }; true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`/Commits could not be read/.test((document.querySelector('#cost-spend .spend-headline') || {}).textContent || '')`, 'the reason', 6000);
            assert.equal(await text('#cost-spend .spend-headline'), 'Commits could not be read: no repository found for this team. 3.1 M tokens were spent.');
            await ev(`window.__spend = ${JSON.stringify(FIX)}; true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`/517 K tokens per commit/.test((document.querySelector('#cost-spend .spend-headline') || {}).textContent || '')`, 'back to normal', 6000);
        });
        await run('the trend toggles: Tool calls changes the chart and its name, Hourly draws 24 hours', async () => {
            const pick = (group, key) => ev(`document.querySelector('#cost-spend .spend-toggle[aria-label="${group}"] [data-key="${key}"]').click(); true`);
            await pick('Trend shows', 'tools');
            assert.match(await text('#cost-spend .spend-chart-head h4'), /Tool calls per commit, each day/);
            assert.match(await ev(`document.querySelector('#cost-spend .spend-bars').getAttribute('aria-label')`), /Tool calls per commit each day/);
            await pick('Trend by', 'hour');
            assert.match(await text('#cost-spend .spend-chart-head h4'), /Tool calls per commit, each hour/);
            assert.equal(await ev(`document.querySelectorAll('#cost-spend .spend-bar-col').length`), 24, '24 hours');
            assert.equal(await ev(`document.querySelectorAll('#cost-spend .spend-bar').length`), 6, 'only the hours with a commit have a bar');
            await pick('Trend shows', 'tokens'); await pick('Trend by', 'day');
            assert.match(await text('#cost-spend .spend-chart-head h4'), /Tokens per commit, each day/);
        });
        await run('shots of the two views (CORAL_SCREENSHOT_DIR)', async () => {
            const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return;
            const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true });
            for (const [key, name] of [['per-commit', 'tokens-per-commit'], ['task-time', 'task-time']]) {
                await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'analytics_views.js'); m.selectView(${JSON.stringify(key)}); return true; })()`);
                await new Promise(r => setTimeout(r, 600)); // sleep-ok: the view draws after the choice
                fs.writeFileSync(`${d}/analytics-${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
            }
        });
        await run('the two views are one page shape (#7688): a summary sentence, the tiles, the chart beside "How it is counted", the table under its title with the same gap', async () => {
            assert.equal(await text('#cost-task-time .spend-headline'), '14 tasks done, median 38 min, usual 31 min.', 'Task time has its summary sentence');
            const shape = await ev(`(() => { const out = {}; for (const id of ['cost-spend', 'cost-task-time']) { const r = document.getElementById(id), grid = r.querySelector('.spend-grid'), title = r.querySelector('.spend-who .spend-box-title'), how = r.querySelector('.spend-grid .spend-how > summary');
                out[id] = { how: how && how.textContent, kids: [...r.querySelectorAll(':scope .spend-body > *, :scope .time-body > *')].map(e => e.className.split(' ')[0]).join(','), gap: grid && title ? [getComputedStyle(grid).marginBottom, getComputedStyle(title.closest('.spend-who')).marginTop, title.closest('.spend-who').previousElementSibling === grid].join('/') : null, card: !!r.querySelector('.spend-grid .spend-box') }; } return out; })()`);
            assert.equal(shape['cost-spend'].how, 'How it is counted'); assert.equal(shape['cost-task-time'].how, 'How it is counted', 'Task time has the disclosure too');
            assert.equal(shape['cost-spend'].kids, shape['cost-task-time'].kids, 'the same skeleton: ' + JSON.stringify(shape));
            assert.ok(shape['cost-spend'].gap && shape['cost-spend'].gap.endsWith('/true') && shape['cost-spend'].gap === shape['cost-task-time'].gap, 'the table follows the chart row with the same spacing: ' + JSON.stringify([shape['cost-spend'].gap, shape['cost-task-time'].gap]));
        });
        await run('Task time: six tiles, tasks done with Daily and Hourly, by agent; a measure the endpoint does not return is left out', async () => {
            const cards = await ev(`[...document.querySelectorAll('#cost-task-time .spend-card')].map(c => c.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.equal(cards.length, 6, JSON.stringify(cards));
            assert.ok(/^14\s*tasks done, last 24 h\s*usual 11 a day/.test(cards[0]), cards[0]); assert.ok(/^38 min\s*median, claimed to done\s*usual 31 min/.test(cards[1]), cards[1]);
            assert.ok(/^2 h 05 min\s*slowest 1 in 10\s*usual 1 h 40 min/.test(cards[2]), cards[2]); assert.ok(/^12 min\s*median wait before claimed/.test(cards[3]), cards[3]);
            assert.ok(/^47 min\s*median in review, assignment to approval/.test(cards[4]), cards[4]); assert.ok(/^3 of 14\s*sent back 2 or more times\s*1\.6 rounds on average/.test(cards[5]), cards[5]);
            assert.equal(await ev(`document.querySelectorAll('#cost-task-time .spend-bar').length`), 6, 'the day with no task done has no bar');
            await ev(`window.__spend.task_time.per_day[window.__spend.task_time.per_day.length - 1].done = 99; true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`document.querySelectorAll('#cost-task-time .spend-bar').length > 0`, 'the chart again', 6000);
            assert.equal(await ev(`document.querySelectorAll('#cost-task-time .spend-bar-high').length`), 0, 'more tasks done than usual is not drawn in the warning colour');
            assert.ok(!/amber/.test(await text('#cost-task-time .spend-box .spend-note')), 'and its caption does not promise amber');
            await ev(`document.querySelector('#cost-task-time .spend-toggle [data-key="hour"]').click(); true`);
            assert.equal(await ev(`document.querySelectorAll('#cost-task-time .spend-bar-col').length`), 24);
            await ev(`document.querySelector('#cost-task-time .spend-toggle [data-key="day"]').click(); true`);
            const rows = await ev(`[...document.querySelectorAll('#cost-task-time .dt-table tbody tr')].map(r => [...r.children].map(c => c.textContent.trim()))`);
            assert.deepEqual(rows, [['Frontend Dev', '5', '52 min', '2'], ['Backend Dev', '3', '34 min', '0']]);
            await ev(`delete window.__spend.task_time.window.p90_s; delete window.__spend.task_time.window.wait_median_s; true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`document.querySelectorAll('#cost-task-time .spend-card').length === 4`, 'two measures left out', 6000);
            assert.ok(!(await ev(`document.getElementById('cost-task-time').textContent`)).match(/slowest|wait before/), 'no slowest and no wait tile, and no 0 or dash in their place');
            await ev(`window.__spend = ${JSON.stringify(FIX)}; true`);
        });
        await run('no commit landed is said, not divided by zero', async () => {
            await ev(`window.__spend = { ...window.__spend, commits: { window: 0, usual: 25, unattributed: 0 } }; true`); await ev(`window._refreshCostDashboard ? window._refreshCostDashboard() : 0; true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`/No commit landed/.test((document.querySelector('#cost-spend .spend-headline') || {}).textContent || '')`, 'the no-commit headline', 6000);
            assert.equal(await text('#cost-spend .spend-headline'), 'No commit landed in 24 h. 3.1 M tokens were spent.');
        });
        await run('the 7 day range asks range=7d; a 404 says there is no data', async () => {
            await ev(`document.getElementById('cost-time-range').value = 'week'; document.getElementById('cost-time-range').dispatchEvent(new Event('change', { bubbles: true })); true`);
            await waitFor(`window.__spendReq.some(s => /range=7d/.test(s))`, 'a request with range=7d', 6000);
            await waitFor(`/Hourly is for the last 24 hours\\./.test((document.querySelector('#cost-spend .spend-chart .spend-note') || {}).textContent || '')`, 'the reason in the chart note, not only in a tooltip', 6000);
            assert.match(await text('#cost-task-time .spend-box .spend-note'), /Hourly is for the last 24 hours\./, 'Tasks done says it too');
            await ev(`window.__spendStatus = 404; true`); await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`/No spend data for this team yet/.test(document.getElementById('cost-spend').textContent)`, 'the no-data line', 6000);
        });
        await run('at 390 px nothing is wider than the screen', async () => {
            await ev(`window.__spendStatus = 200; window.__spend = ${JSON.stringify(FIX)}; document.getElementById('cost-time-range').value = 'day'; true`);
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await Emulation.setTouchEmulationEnabled({ enabled: true });
            // The earlier capture visits Task time; this measurement is Tokens per commit.
            await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => { m.selectView('per-commit'); return true; })`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`document.querySelectorAll('#cost-spend .spend-card').length >= 5 && document.querySelector('#cost-spend .spend-card')?.getBoundingClientRect().width > 0`, 'Tokens per commit refreshed and visible on the phone', 6000);
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), true);
            // The missing-data headline is words, unlike the numeric tiles: it must remain inside its tile on a phone (#8609).
            await ev(`window.__spend.tool_calls.measured_agents = 0; true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`document.querySelectorAll('#cost-spend .spend-card .cost-card-value')[1]?.textContent === 'Not measured' && document.querySelectorAll('#cost-spend .spend-card')[1]?.getBoundingClientRect().width > 0`, 'the word headline', 6000);
            const words = await ev(`(() => { const cards = [...document.querySelectorAll('#cost-spend .spend-card')], e = cards[1].querySelector('.cost-card-value'), box = cards[1].getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(e); const rects = [...range.getClientRects()]; return { text: e.textContent, fits: rects.length > 0 && rects.every(r => r.left >= box.left + 10 && r.right <= box.right - 10), overlaps: cards.some((c, i) => cards.slice(i + 1).some(d => { const a = c.getBoundingClientRect(), b = d.getBoundingClientRect(); return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1; })) }; })()`);
            assert.deepEqual(words, { text: 'Not measured', fits: true, overlaps: false }, 'the whole word headline fits without colliding with another tile');
            await shot('word-headline-390');
        });
        await run('through a hub a remote team\'s spend is read on its own machine (/api/remote/<server>/api/board/<team>/spend), never on the hub itself (#8693)', async () => {
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
            await ev(`(() => { window.__spendPaths = []; try { localStorage.removeItem('coral-analytics-spend-team'); } catch {} window._coralSetLiveSessions([{ session_id: 'r-1', name: 'r-1', agent_type: 'claude', server: 'box-2', board_project: 'remote-team', display_name: 'Remote Dev', working_directory: '/tmp/x' }]); return true; })()`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`window.__spendPaths.length > 0`, 'the spend read for the remote team', 8000);
            const paths = await ev(`window.__spendPaths`);
            assert.deepEqual([...new Set(paths)], ['/api/remote/box-2/api/board/remote-team/spend'], 'the read goes through the hub to box-2: ' + JSON.stringify(paths));
        });
        await run('two teams called alpha on two computers are two options in the Team picker, told apart by their computer (#8774)', async () => {
            await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; st.hub = true; st.servers = [{ id: 'box-2', label: 'Box Two', status: 'online' }];
                window._coralSetLiveSessions([{ session_id: 'a-l', name: 'a-l', agent_type: 'claude', board_project: 'alpha', display_name: 'Local Dev', working_directory: '/tmp/x' }, { session_id: 'a-r', name: 'a-r', agent_type: 'claude', server: 'box-2', board_project: 'alpha', display_name: 'Remote Dev', working_directory: '/tmp/x' }]);
                const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard(); return true; })()`);
            await waitFor(`document.querySelectorAll('#cost-spend select option').length >= 2`, 'the picker with two teams', 8000);
            const opts = await ev(`[...document.querySelectorAll('#cost-spend select option')].map(o => [o.value, o.textContent])`);
            assert.equal(opts.length, 2, JSON.stringify(opts));
            assert.notEqual(opts[0][1], opts[1][1], 'the two labels differ: ' + JSON.stringify(opts));
            assert.ok(opts.some(([v, t]) => v === 'alpha' && /This computer/.test(t)) && opts.some(([v, t]) => v === '@box-2/alpha' && /Box Two/.test(t)), JSON.stringify(opts));
            // the shots: the picker as a list (a native select's popup is not in a screenshot), at 1280 and at 390
            await ev(`(() => { const s = document.querySelector('#cost-spend select'); s.size = s.options.length + 1; s.scrollIntoView({ block: 'center' }); return true; })()`);
            await shot('team-picker-1280');
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await ev(`(() => { const s = document.querySelector('#cost-spend select'); s.scrollIntoView({ block: 'center' }); return true; })()`);
            await shot('team-picker-390');
            await ev(`document.querySelector('#cost-spend select').size = 0; true`);
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        });
    } finally { await client.close(); }
    const bad = results.filter(r => r[1]); console.log(`${results.length - bad.length}/${results.length} scenarios pass`); if (bad.length) { console.error('FAIL: ' + bad.map(r => r[0]).join('; ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
