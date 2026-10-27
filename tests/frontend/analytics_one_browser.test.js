// Analytics on the shared sidebar (#7473, part 2 of one sidebar, UI/UX's audit c2596330): the pane has the header's parts in the same pixels as the other tabs (search "Search views", Display options holding the time range,
// Hide), no pinned action (nothing is created here) and the list of views (Overview, one per table, Tokens per commit, Task time); the page is one view at a time under a 20/700 title with the range and the live mark
// under it; Overview has seven tiles of one size (20/700, labels 12/500) and the cumulative chart; each other view is its own section; the range is chosen in Display options and the page says it; the search narrows
// the list; both themes and 200% text; a phone's list is the page and a view the screen after it. Drives Chrome over CDP through agent_view_harness.js, stubbed API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

const MODEL = [{ model: 'claude-opus-5-5', agent_type: 'claude', num_sessions: 3, input_tokens: 2000, output_tokens: 300, cache_read_tokens: 10, cache_write_tokens: 5, cost_usd: 2.5 },
    { model: 'claude-sonnet-5-5', agent_type: 'claude', num_sessions: 1, input_tokens: 900, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.4 }];
const PROVIDER = [{ agent_type: 'claude', num_sessions: 4, input_tokens: 2900, output_tokens: 400, cache_read_tokens: 10, cache_write_tokens: 5, cost_usd: 2.9 },
    { agent_type: 'agy', num_sessions: 1, input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.25 }];
const THINKING = [{ agent_type: 'claude', model: 'claude-opus-5-5', thinking: 'high', input_tokens: 2000, output_tokens: 300, cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 4000, cost_usd: 2.0, num_calls: 9 },
    { agent_type: 'claude', model: 'claude-sonnet-5-5', thinking: 'low', input_tokens: 800, output_tokens: 60, cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0, cost_usd: 1.0, num_calls: 4 },
    { agent_type: 'agy', model: '', thinking: '', input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0, cost_usd: 0.25, num_calls: 0 }];
const AGENT = [{ session_id: 'a1', agent_name: 'Frontend Dev', board_name: 'coral-go-team', folder: 'coral', requests: 12, input_tokens: 5000, output_tokens: 700, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 3.2, first_seen: '2026-10-19T00:00:00Z', last_seen: '2026-10-19T01:00:00Z' },
    { session_id: 'a2', agent_name: 'QA Engineer', board_name: 'coral-go-team', folder: 'coral', requests: 4, input_tokens: 900, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.6, first_seen: '2026-10-19T00:00:00Z', last_seen: '2026-10-19T00:30:00Z' }];
const TEAMS = [{ board_name: 'coral-go-team', num_agents: 6, input_tokens: 9000, output_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 8.5 },
    { board_name: 'docs-sprint', num_agents: 2, input_tokens: 900, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.9 }];
const BRANCHES = [{ repo_name: 'coral', branch: 'main', board_name: 'coral-go-team', pr_number: 0, num_agents: 6, input_tokens: 9000, output_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 8.5 },
    { repo_name: 'coral', branch: 'fix/cost', board_name: 'docs-sprint', pr_number: 12, num_agents: 2, input_tokens: 900, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.9 }];


const TASKS = [{ id: 86091, title: 'Named agent task', status: 'completed', assigned_to: 'Backend Dev', priority: 'high', cost_usd: 1.25 },
    { id: 86092, title: 'Unassigned task', status: 'completed', assigned_to: null, priority: 'low', cost_usd: 0.5 }];
const VIEWS = ['Overview', 'Tokens per commit', 'Task time', 'Tool and API calls']; // one entry per metric (#9236)
const GROUP_OF = { 'By provider': 'Provider', 'By model': 'Model', 'By thinking level': 'Thinking level', 'By team': 'Team', 'By agent': 'Agent', 'By branch': 'Branch', 'By task': 'Task' }; // the groupings are Overview's Group by (#9236), not sidebar entries
const STUB = `(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o) => { const url = String(u && u.url || u); window.__costReq = (window.__costReq || []).concat(url);
        if (new URL(url, location.origin).pathname === '/api/board/tasks') return json({ tasks: ${JSON.stringify(TASKS)} });
        if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 10, output_tokens: 20, cost_usd: 4 }, by_model: ${JSON.stringify(MODEL)}, by_thinking: ${JSON.stringify(THINKING)}, by_agent_type: ${JSON.stringify(PROVIDER)}, by_agent: ${JSON.stringify(AGENT)} });
        if (url.includes('/api/token-usage/timeseries')) {
            const since = Date.parse(new URL(url, location.origin).searchParams.get('since'));
            const long = Date.now() - since > 2 * 86400000, step = long ? 86400000 : 3600000;
            return json({ buckets: Array.from({ length: long ? 7 : 25 }, (_, i) => ({ bucket: new Date(Date.UTC(2026, 9, 19, 12) + i * step).toISOString(), cost_usd: 1, cumulative_cost: i + 1 })) });
        }
        if (url.includes('/api/token-usage/by-team')) return json({ teams: ${JSON.stringify(TEAMS)} });
        if (url.includes('/api/token-usage/by-branch')) return json({ branches: ${JSON.stringify(BRANCHES)} });
        if (url.includes('/api/token-usage/')) return json({});
        return R(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const pane = `.sidebar-pane[data-pane="tokens"]`;
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })()`);
    const ON_SCALE = `(root, sizes) => { const want = getComputedStyle(document.body).fontFamily, out = [];
        for (const e of root.querySelectorAll('*')) { if (!e.getClientRects().length || e.matches('.material-icons, .sr-only, pre, code, svg, svg *') || e.closest('pre, code')) continue;
            if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
            const c = getComputedStyle(e), px = parseFloat(c.fontSize); const label = e.tagName + '.' + e.className + ' "' + e.textContent.trim().slice(0, 24) + '" ' + c.fontSize + '/' + c.fontWeight;
            if (c.fontFamily !== want) out.push('family ' + label); else if (!sizes.includes(px)) out.push('size ' + label); else if (!['400', '500', '600', '700'].includes(c.fontWeight)) out.push('weight ' + label); }
        return out; }`;
    const SCALE = '[11, 12, 13, 14, 17, 20]';
    const openTab = async () => {
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`!document.querySelector('${pane}').hidden && document.querySelectorAll('${pane} li .row-btn').length === ${VIEWS.length}`, 'the Analytics pane with its views', 10000);
    };
    const choose = async label => {
        const g = GROUP_OF[label];
        if (g) {
            await ev(`[...document.querySelectorAll('#cost-group-bar .eff-seg-btn')].find(b => b.textContent === ${JSON.stringify(g)}).click(); true`);
            await waitFor(`document.getElementById('cost-view-title').textContent === 'Overview' && document.querySelector('#cost-group-bar .eff-seg-btn[aria-pressed="true"]').textContent === ${JSON.stringify(g)}`, 'Overview grouped by ' + g, 6000);
            return;
        }
        await ev(`[...document.querySelectorAll('${pane} li .row-btn')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click(); true`);
        await waitFor(`document.getElementById('cost-view-title').textContent === ${JSON.stringify(label)}`, 'the ' + label + ' view', 6000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [1024, 768, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.clear(); window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);

            await openTab();
            assert.deepEqual(await ev(`[...document.querySelectorAll('${pane} li .row-btn')].map(b => b.textContent.trim())`), VIEWS, at + 'the list is the views, in order');
            assert.equal(await ev(`document.querySelector('${pane} li .row-btn[aria-current="true"]').textContent.trim()`), 'Overview', at + 'Overview is the one open');
            assert.equal(await ev(`document.querySelector('${pane} .sidebar-search-input').getAttribute('aria-label')`), 'Search views', at + 'the search is named for the tab');
            assert.equal(await ev(`!!document.querySelector('${pane} [data-display-button]')`), false, at + 'no Display options here: the time range is in the page header (#7666)');
            assert.equal(await ev(`!!document.querySelector('${pane} .sidebar-footer')`), false, at + 'no pinned action: nothing is created here');
            assert.equal(await ev(`[...document.querySelectorAll('${pane} .group-toggle-btn')].some(b => b.getClientRects().length > 0)`), false, at + 'no Expand or collapse all: there are no groups');
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll');

            if (mobile) {
                assert.equal(await ev(`!!document.querySelector('#mobile-analytics-list ${pane}')`), true, at + 'the pane is in the phone page');
                assert.equal(await ev(`[...document.querySelectorAll('#mobile-analytics-list .sidebar-hide-btn')].some(b => b.getClientRects().length > 0)`), false, at + 'no Hide on a phone');
                assert.equal(await ev(`document.getElementById('cost-page').getClientRects().length`), 0, at + 'the page is not shown until a view is chosen');
                assert.deepEqual(await ev(`(() => { const rows = [...document.querySelectorAll('${pane} li')].filter(l => l.querySelector('.row-btn')); return [rows.length, [...new Set(rows.map(l => Math.round(l.getBoundingClientRect().height)))]]; })()`), [4, [44]], at + 'the views are the shared row: 44 px on a phone');
                await shot(`analytics-one-list-${w}`);
                await choose('By model');
                await waitFor(`document.getElementById('cost-page').getClientRects().length > 0`, at + 'the view as a screen', 6000);
                assert.equal(await ev(`document.getElementById('mobile-analytics-list').getClientRects().length`), 0, at + 'and the list is not under it');
                assert.equal(await ev(`document.querySelector('.cost-phone-back').textContent.trim()`), '\u2190 Analytics', at + 'with the way back');
                assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, at + 'no sideways scroll on the view');
                await shot(`analytics-one-view-${w}`);
                const pr = await ev(`(() => { const s = document.getElementById('cost-time-range'), r = s.getBoundingClientRect(), b = document.querySelector('.cost-header-actions [data-on-click="cost-refresh"]').getBoundingClientRect(); return { count: document.querySelectorAll('#cost-time-range').length, shown: r.width > 0, beside: Math.abs((r.top + r.bottom) / 2 - (b.top + b.bottom) / 2) < 8 && r.right <= b.left + 1, inView: r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && scrollY === 0, h: Math.round(r.height), side: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
                assert.ok(pr.count === 1 && pr.shown && pr.beside && pr.inView && pr.h >= 44 && pr.side <= 0, at + 'the phone view has the time range in the header beside Refresh, 44 px, in view without scrolling: ' + JSON.stringify(pr));
                await shot(`analytics-one-range-${w}`);
                await ev(`document.querySelector('.cost-phone-back').click(); true`);
                await waitFor(`document.getElementById('mobile-analytics-list').getClientRects().length > 0 && document.getElementById('cost-page').getClientRects().length === 0`, at + 'back is the list', 4000);
                assert.equal(await ev(`document.activeElement.dataset.view`), 'overview', at + 'back puts the focus on the view just left (Overview: the Model grouping is Overview with a choice made), not on the first row');
                continue;
            }

            // the header's parts are in the same pixels as on Agents
            const parts = {};
            for (const tab of ['agents', 'tokens']) { await ev(`window.switchNavTab(${JSON.stringify(tab)}); true`); await waitFor(`!document.querySelector('.sidebar-pane[data-pane="${tab}"]').hidden`, at + tab, 8000); parts[tab] = { hide: await rect(`.sidebar-pane[data-pane="${tab}"] .sidebar-hide-btn`), search: await rect(`.sidebar-pane[data-pane="${tab}"] .sidebar-search-input`) }; }
            assert.deepEqual(parts.tokens.hide, parts.agents.hide, at + 'Hide is in the same place as on Agents');
            assert.deepEqual(parts.tokens.search.slice(0, 2), parts.agents.search.slice(0, 2), at + 'the search starts in the same place');
            await openTab();

            // Overview: the title, the range and the live mark, seven tiles of one size, the chart; nothing of the other views
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.getElementById('cost-view-title')); return [document.getElementById('cost-view-title').textContent, t.fontSize, t.fontWeight]; })()`), ['Overview', '20px', '700'], at + 'the title is the view, 20/700');
            assert.equal(await ev(`document.getElementById('cost-range-line').textContent.replace(/\\s+/g, ' ').trim()`), 'Last 24 hours · Change against the prior 24 hours Live', at + 'the range, prior-period comparison and live mark under it');
            assert.deepEqual(await ev(`[...new Set([...document.querySelectorAll('#cost-summary-cards .cost-card-value')].map(e => getComputedStyle(e).fontSize + '/' + getComputedStyle(e).fontWeight))]`), ['20px/700'], at + 'every tile number is 20/700');
            assert.deepEqual(await ev(`[...new Set([...document.querySelectorAll('#cost-summary-cards .cost-card-label')].map(e => getComputedStyle(e).fontSize + '/' + getComputedStyle(e).fontWeight))]`), ['12px/500'], at + 'every tile label is 12/500');
            assert.equal(await ev(`document.querySelectorAll('#cost-summary-cards .cost-card').length`), 7, at + 'seven tiles');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-summary-cards .cost-card-value')].filter(v => { const r = document.createRange(); r.selectNodeContents(v); return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size > 1; }).map(v => v.textContent)`), [], at + 'every figure is on one line, whole');
            assert.deepEqual(await ev(`(() => { const rows = [...document.querySelectorAll('${pane} li')].filter(l => l.querySelector('.row-btn')); const h = [...new Set(rows.map(l => Math.round(l.getBoundingClientRect().height)))]; return [rows.length, h]; })()`), [4, [mobile ? 44 : 36]], at + 'the views are the shared sidebar row: 36 px on a desktop, 44 on a phone, the button is the row');
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-dashboard-view [data-cview]')].filter(e => e.getClientRects().length).map(e => e.dataset.cview)`).then(a => [...new Set(a)]), ['overview'], at + 'only the Overview parts are shown');
            assert.deepEqual(await ev(`(() => { const t = getComputedStyle(document.querySelector('#cost-dashboard-view .cost-section[data-cview=overview] .cost-section-title')); return [t.fontSize, t.fontWeight]; })()`), ['14px', '600'], at + 'a section heading is 14/600');
            await waitFor(`document.querySelectorAll('#cost-spend-chart .spend-label').length === 6`, at + 'the cumulative chart labels', 5000);
            assert.equal(await ev(`document.querySelector('#cost-spend-chart .spend-line').getAttribute('points').trim().split(/\\s+/).length`), 25, at + '25 hourly buckets include both ends of the exact 24-hour window');
            assert.ok((await ev(`[...document.querySelectorAll('#cost-spend-chart .spend-label')].slice(-3).map(e => e.textContent)`)).every(t => /\d[:.]\d/.test(t)), at + 'the exact 24-hour axis keeps time labels');
            await shot(`analytics-one-overview-${w}`);

            // choosing a view from the keyboard keeps the focus on its row (the list is drawn again, the button was a new one)
            await ev(`(() => { const b = document.querySelector('${pane} li .row-btn[data-view="per-commit"]'); b.focus(); b.click(); return true; })()`);
            await waitFor(`document.getElementById('cost-view-title').textContent === 'Tokens per commit'`, at + 'Tokens per commit', 4000);
            assert.equal(await ev(`document.activeElement.dataset.view`), 'per-commit', at + 'the focus is still on the row that was chosen');
            await choose('Overview');

            // a table view: its own section under the title; the section heading is for a reader, not drawn twice
            await choose('By provider');
            assert.deepEqual(await ev(`[...new Set([...document.querySelectorAll('#cost-dashboard-view [data-cview]')].filter(e => e.getClientRects().length).map(e => e.dataset.cview))]`), ['provider'], at + 'only the provider section is shown');
            assert.equal(await ev(`document.querySelector('${pane} li .row-btn[aria-current="true"]').textContent.trim()`), 'Overview', at + 'the list marks Overview (the grouping is Overview with a choice made)');
            assert.equal(await ev(`(() => { const t = document.querySelector('#cost-dashboard-view .cost-section[data-cview=provider] .cost-section-title'); const r = t.getBoundingClientRect(); return r.width <= 1 && r.height <= 1; })()`), true, at + 'its heading is not drawn a second time');
            assert.equal(await ev(`document.getElementById('cost-status').textContent`), 'Showing By provider', at + 'a status line says what is showing');
            assert.ok(await ev(`document.querySelectorAll('#cost-by-provider tbody tr').length`) >= 2, at + 'the table has its rows');
            await shot(`analytics-one-provider-${w}`);
            for (const label of ['By thinking level', 'By team', 'Tokens per commit', 'Task time']) { await choose(label); await shot(`analytics-one-${label.toLowerCase().replace(/ /g, '-')}-${w}`); }

            // the time range is one select in the page header, beside Refresh, on every view; the sidebar has no copy (#7666)
            assert.equal(await ev(`!!document.querySelector('${pane} [data-display-button]') || !!document.querySelector('${pane} #cost-time-range')`), false, at + 'the sidebar has no Display options and no Time range');
            const range = () => ev(`(() => { const s = document.getElementById('cost-time-range'), r = s && s.getBoundingClientRect(); const b = document.querySelector('.cost-header-actions [data-on-click="cost-refresh"]'), q = b && b.getBoundingClientRect(); const h = document.querySelector('.cost-header').getBoundingClientRect();
                return s ? { count: document.querySelectorAll('#cost-time-range').length, name: s.getAttribute('aria-label'), shown: r.width > 0 && getComputedStyle(s).visibility !== 'hidden', inActions: !!s.closest('.cost-header-actions'), beside: q.width > 0 && Math.abs((r.top + r.bottom) / 2 - (q.top + q.bottom) / 2) < 8 && r.right <= q.left + 1, right: r.right <= h.right + 1 && r.left >= 0, inView: r.top >= 0 && r.bottom <= innerHeight && scrollY === 0, h: Math.round(r.height) } : null; })()`);
            for (const label of VIEWS) {
                await choose(label);
                const r = await range();
                assert.ok(r && r.count === 1 && r.shown && r.inActions && r.beside && r.right && r.inView, at + `${label}: the time range is in the header beside Refresh, reachable without scrolling: ` + JSON.stringify(r));
                assert.equal(r.name, 'Time range', at + `${label}: the select is named`);
                if (mobile) assert.ok(r.h >= 44, at + `${label}: a 44 px target on a phone: ` + r.h);
            }
            await choose('By task');
            await waitFor(`document.querySelectorAll('#cost-by-task tbody tr').length === 2`, at + 'the seeded task rows', 5000);
            const people = await ev(`[...document.querySelectorAll('#cost-by-task tbody tr')].map(r => r.querySelector('[data-key="assigned_to"]').textContent.trim())`);
            assert.deepEqual(people, ['BBackend Dev', '—'], at + 'By task shows the named agent beside its circle; only an unassigned task has a dash');
            await choose('Overview');
            await ev(`(() => { const s = document.getElementById('cost-time-range'); s.value = 'week'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.getElementById('cost-range-text').textContent === 'Last 7 days'`, at + 'the page says the range', 5000);
            const expectedDays = await ev(`[0, 3, 6].map(i => new Date(Date.UTC(2026, 9, 19, 12) + i * 86400000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))`);
            await waitFor(`document.querySelectorAll('#cost-spend-chart .spend-label').length === 6 && [...document.querySelectorAll('#cost-spend-chart .spend-label')].slice(-3).map(e => e.textContent).join('|') === ${JSON.stringify(expectedDays.join('|'))}`, at + 'the seven-day axis names its dates', 5000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-spend-chart .spend-label')].slice(-3).map(e => e.textContent)`), expectedDays, at + 'multi-day endpoints and midpoint are dates, not three times of day');

            await choose('Task time');
            assert.equal(await ev(`document.getElementById('cost-time-range').value`), 'week', at + 'the one state follows to the other views');
            await shot(`analytics-one-range-${w}`);
            await choose('Overview');

            // the search narrows the list
            await ev(`(() => { const i = document.querySelector('${pane} .sidebar-search-input'); i.value = 'task'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('${pane} li .row-btn').length === 1`, at + 'the search narrows the list', 5000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('${pane} li .row-btn')].map(b => b.textContent.trim())`), ['Task time'], at + 'to the match');
            await ev(`(() => { const i = document.querySelector('${pane} .sidebar-search-input'); i.value = 'zzz'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`!!document.querySelector('${pane} .empty-state')`, at + 'no match says so', 5000);
            await ev(`(() => { const i = document.querySelector('${pane} .sidebar-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('${pane} li .row-btn').length === ${VIEWS.length}`, at + 'cleared', 5000);

            // every text on the scale, in every view
            if (w === 1280) {
                await ev(`(() => { const s = document.getElementById('cost-time-range'); s.value = 'day'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                for (const label of VIEWS) {
                    await choose(label);
                    await waitFor(`document.getElementById('cost-page').getClientRects().length > 0`, at + label, 4000);
                    assert.deepEqual(await ev(`(${ON_SCALE})(document.getElementById('cost-page'), ${SCALE})`), [], at + label + ': every text is on the scale');
                }
                await choose('Overview');

                // both themes and 200% text: contrast, inside the screen
                for (const theme of ['dark', 'light']) for (const zoom of ['', '32px']) {
                    const how = at + `${theme}${zoom ? ', 200% text' : ''}: `;
                    await setTheme(ev, theme); await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; true`);
                    for (const label of ['Overview', 'By model']) {
                        await choose(label);
                        const au = await auditRegion(ev, ['.sidebar', '#cost-page']);
                        assert.deepEqual(au.fails.map(f => `${f.sel} ${f.what} ${f.ratio}`), [], how + label + ': contrast');
                        assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, how + label + ': no sideways scroll');
                        if (label === 'Overview') assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-summary-cards .cost-card')].filter(c => c.scrollWidth > c.clientWidth + 1 || c.getBoundingClientRect().right > document.getElementById('cost-page').getBoundingClientRect().right + 1 || [...c.querySelectorAll('.cost-card-value, .cost-card-label')].some(v => v.scrollWidth > v.clientWidth + 1)).map(c => c.textContent.trim().slice(0, 20))`), [], how + 'no tile clips its figure or its label (they wrap when the text is large)');
                    }
                }
                await setTheme(ev, 'dark'); await ev(`document.documentElement.style.fontSize = ''; true`);
            }
        }
        console.log('PASS analytics on the shared sidebar: views, title and range, tiles, search, phone screens');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
