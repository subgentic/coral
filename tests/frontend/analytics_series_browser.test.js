// The breakdown views over time (#7857): a line per table row above By team (and By agent, By provider, By model), the table as the legend (a swatch button, a row click), top 7 and Other, a metric picker, a
// running total or each hour, the tooltip, the "Totals agree" line, the phone, and a chart that is unavailable leaving the table whole. From stubbed /api/token-usage/* answers (the totals of the lines are the
// tables' totals, as the server's are). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { setTheme } = require('./helpers/contrast');

const NAMES = ['coral-go-team', 'hub-team', 'docs-sprint', 'checkout-redesign', 'infra-ops', 'mobile-fix', 'research', 'qa-lab', 'design-sys'];
const TEAMS = NAMES.map((n, i) => ({ board_name: n, num_agents: 9 - i, input_tokens: (9 - i) * 1000, output_tokens: (9 - i) * 100, cache_read_tokens: (9 - i) * 5000, cache_write_tokens: 0, cost_usd: (9 - i) * 1.5 }));
const AGENTS = [{ session_id: 'a1', agent_name: 'Frontend Dev', board_name: 'coral-go-team', folder: 'coral', requests: 12, input_tokens: 5000, output_tokens: 700, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 3.2, first_seen: '2026-10-21T05:00:00Z', last_seen: '2026-10-21T06:00:00Z' },
    { session_id: 'a2', agent_name: 'QA Engineer', board_name: 'coral-go-team', folder: 'coral', requests: 4, input_tokens: 900, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.6, first_seen: '2026-10-21T05:00:00Z', last_seen: '2026-10-21T05:30:00Z' }];
const PROVIDERS = [{ agent_type: 'claude', num_requests: 10, input_tokens: 9000, output_tokens: 900, cache_read_tokens: 100, cache_write_tokens: 10, cost_usd: 8 }, { agent_type: 'codex', num_requests: 6, input_tokens: 2000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 1.5 }];
const MODELS = [{ model: 'claude-opus-5-5', agent_type: 'claude', num_requests: 10, input_tokens: 9000, output_tokens: 900, cache_read_tokens: 100, cache_write_tokens: 10, cost_usd: 8 }, { model: 'gpt-5-codex', agent_type: 'codex', num_requests: 6, input_tokens: 2000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 1.5 }];
const tot = k => TEAMS.reduce((a, t) => a + t[k], 0);
// a day of hourly buckets whose lines add up to each row's figure
const sum = (rows, k, d = 24) => rows.reduce((a, r) => a + (r[k] || 0), 0) / d;
const series = (rows, key) => Array.from({ length: 24 }, (_, h) => ({ cost_usd: sum(rows, 'cost_usd'), input_tokens: sum(rows, 'input_tokens'), output_tokens: sum(rows, 'output_tokens'), cache_read_tokens: sum(rows, 'cache_read_tokens'), cache_write_tokens: sum(rows, 'cache_write_tokens'), num_requests: sum(rows.map(r => ({ n: r.requests || 1 })), 'n'), bucket: new Date(Date.now() - (23 - h) * 3600000).toISOString().replace(/:\d\d:\d\d\.\d+Z$/, ':00:00Z'), series: rows.map(r => ({ key: key(r), label: key(r),
    cost_usd: r.cost_usd / 24, input_tokens: r.input_tokens / 24, output_tokens: r.output_tokens / 24, cache_read_tokens: (r.cache_read_tokens || 0) / 24, cache_write_tokens: (r.cache_write_tokens || 0) / 24, num_requests: (r.requests || 1) / 24 })) }));

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const MOD = `(window.__coralStatic || '/static/')`;
    const stub = (extra = '') => ev(`(() => { const R = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
        window.__fail = false; window.fetch = (u, o) => { const url = String(u && u.url || u);
            if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: ${tot('input_tokens')}, output_tokens: ${tot('output_tokens')}, cost_usd: ${tot('cost_usd')}, num_requests: 16 }, by_agent_type: ${JSON.stringify(PROVIDERS)}, by_model: ${JSON.stringify(MODELS)}, by_thinking: [], by_agent: ${JSON.stringify(AGENTS)} });
            if (url.includes('/api/token-usage/by-team')) return json({ teams: ${JSON.stringify(TEAMS)} });
            if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
            if (url.includes('/api/token-usage/timeseries')) { if (window.__fail) return json({}, 500); const q = new URL(url, location.origin).searchParams, g = q.get('group_by'); if (q.get('until')) return json({ buckets: [{ bucket: new Date(Date.now() - 30 * 3600000).toISOString().replace(/:\\d\\d:\\d\\d\\.\\d+Z$/, ':00:00Z'), cost_usd: ${tot('cost_usd') / 2}, input_tokens: ${tot('input_tokens') / 2}, output_tokens: ${tot('output_tokens') / 2}, cache_read_tokens: ${tot('cache_read_tokens') / 2}, cache_write_tokens: ${tot('cache_write_tokens') / 2}, num_requests: 8 }], interval: '1d' }); return json({ buckets: g === 'agent' ? ${JSON.stringify(series(AGENTS, r => r.agent_name))} : g === 'provider' ? ${JSON.stringify(series(PROVIDERS.map(r => ({ ...r, requests: r.num_requests })), r => r.agent_type))} : g === 'model' ? ${JSON.stringify(series(MODELS.map(r => ({ ...r, requests: r.num_requests })), r => r.model))} : ${JSON.stringify(series(TEAMS, r => r.board_name))}, interval: '1h' }); }
            if (url.includes('/api/token-usage/')) return json({});
            return R(u, o); }; ${extra} return true; })()`);
    const view = async key => { await ev(`import(${MOD} + 'analytics_views.js').then(m => { m.selectView(${JSON.stringify(key)}); return true; })`); };
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Emulation.setEmulatedMedia({ features: mobile ? [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] : [] });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await stub();
        await ev(`window.switchNavTab('tokens'); true`);
        // Tab entry owns the phone's list/view state. Choose after that entry has drawn,
        // rather than inspecting a chart left in the hidden page by an early selectView.
        await waitFor(`document.querySelector('#cost-nav-list .row-btn[data-view="overview"]')?.getClientRects().length > 0`, 'the Analytics view list', 10000);
        await ev(`document.querySelector('#cost-nav-list .row-btn[data-view="overview"]').click(); true`); // Overview opens: on a phone that is the screen after the list, and it holds the Group by
        await ev(`[...document.querySelectorAll('#cost-group-bar .eff-seg-btn')].find(b => b.textContent === 'Team').click(); true`); // By team is Overview's Group by Team (#9236)
        await waitFor(`document.getElementById('cost-dashboard-view').dataset.view === 'team' && document.querySelector('#cost-series-team')?.getBoundingClientRect().width > 0`, 'By team is visible', 10000);
        await waitFor(`document.querySelectorAll('#cost-series-team .viz-svg path.viz-line').length > 0 && document.querySelectorAll('#cost-by-team tbody tr').length === ${NAMES.length}`, 'the chart and the table', 15000);
    };
    const lines = () => ev(`[...document.querySelectorAll('#cost-series-team .viz-svg path.viz-line')].map(p => ({ stroke: p.getAttribute('stroke'), w: p.getAttribute('stroke-width'), o: p.getAttribute('opacity') }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await open(1280, 900, false);

        console.log('1. A line per row: the top 7 and Other, the chart hidden from a screen reader, the table as its text');
        const l = await lines();
        assert.equal(l.length, 8, 'seven teams and Other: ' + JSON.stringify(l));
        assert.deepEqual(l.map(x => x.stroke), ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)', 'var(--viz-7)', 'var(--viz-other)']);
        assert.equal(await ev(`document.querySelector('#cost-series-team .viz-svg').getAttribute('aria-hidden')`), 'true');
        const sw = await ev(`[...document.querySelectorAll('#cost-by-team tbody tr')].map(r => { const b = r.querySelector('.cost-toggle'); return b ? [b.firstChild.style.background, b.getAttribute('aria-label'), b.getAttribute('aria-pressed')] : null; })`);
        assert.equal(sw.filter(Boolean).length, NAMES.length, 'every row has its swatch: ' + JSON.stringify(sw));
        assert.match(sw[0][1], /^Show coral-go-team's line$/); assert.deepEqual(sw.map(x => x[2]), ['true', 'true', 'true', 'true', 'true', 'true', 'true', 'false', 'false'], 'pressed when the row has a line of its own; the rows in Other are not');
        assert.equal(await ev(`document.querySelectorAll('#cost-by-team .dt-check').length`), 0, 'one control per row: no checkbox column beside the swatch');
        assert.equal(new Set(sw.slice(0, 7).map(s => s[0])).size, 7, 'seven rows, seven colours');
        assert.equal(sw[7][0], sw[8][0], 'the rows in Other share its colour');
        console.log('   ✓');

        const contrasts = () => ev(`(() => { const cs = getComputedStyle(document.documentElement), lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }, lum = h => { const n = parseInt(h.trim().slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
            const bg = lum(cs.getPropertyValue('--bg-primary')); return ['--viz-1', '--viz-2', '--viz-3', '--viz-4', '--viz-5', '--viz-6', '--viz-7', '--viz-other'].map(v => { const l = lum(cs.getPropertyValue(v)); return [v, Math.round(((Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05)) * 100) / 100]; }); })()`);
        for (const theme of ['dark', 'light']) { await setTheme(ev, theme); const cc = await contrasts(); assert.ok(cc.every(([, r]) => r >= 3), theme + ': every line colour is 3:1 or more against the page: ' + JSON.stringify(cc)); await ev(`document.querySelector('#cost-series-team').scrollIntoView({ block: 'start' }); true`); await shot(`series-team-${theme}`); }
        await setTheme(ev, 'dark');
        console.log('1b. The Overview: the change against the period before, cost by team stacked');
        await view('overview');
        await waitFor(`document.querySelectorAll('#cost-series-overview .viz-fill').length === 8 && /^\\+100%$/.test(document.getElementById('cost-change-cost').textContent)`, 'the stacked chart and the change lines', 12000);
        const ov = await ev(`({ cost: document.getElementById('cost-change-cost').textContent, sub: document.getElementById('cost-range-line').textContent.replace(/\\s+/g, ' ').trim(), input: document.getElementById('cost-change-input').textContent, legend: document.querySelectorAll('#cost-series-overview .viz-legend-btn').length, hidden: document.querySelector('#cost-series-overview .viz-svg').getAttribute('aria-hidden'), title: document.querySelector('#cost-series-overview .viz-title').textContent })`);
        assert.equal(ov.cost, '+100%', JSON.stringify(ov)); assert.equal(ov.input, '+100%'); assert.match(ov.sub, /^Last 24 hours \u00b7 Change against the prior 24 hours/, 'the comparison is said once, in the subtitle: ' + ov.sub); assert.equal(ov.legend, 8); assert.equal(ov.hidden, 'true'); assert.match(ov.title, /^Cost each hour, stacked by team/);
        assert.equal(await ev(`document.querySelectorAll('#cost-series-overview .viz-fill[opacity="1"]').length`), 8, 'every fill is at full strength until one is brought forward');
        assert.equal(await ev(`document.getElementById('cost-change-cache-write').textContent`), '', 'a tile with nothing now and nothing before says nothing, not +100%');
        await ev(`document.getElementById('cost-series-overview').scrollIntoView({ block: 'start' }); true`); await shot('series-overview-fills'); await setTheme(ev, 'light'); await shot('series-overview-fills-light'); await setTheme(ev, 'dark'); await ev(`window.scrollTo(0, 0); true`);
        assert.equal(await ev(`document.querySelectorAll('#cost-series-overview .viz-legend-btn')[0].getAttribute('aria-label')`), "Highlight coral-go-team's line, $13.50", 'the legend button says what it does, with the name and the figure apart (#8022)');
        await ev(`document.querySelectorAll('#cost-series-overview .viz-legend-btn')[2].click(); true`);
        assert.equal(await ev(`document.querySelectorAll('#cost-series-overview .viz-fill[opacity="0.25"]').length`), 7, 'a legend item brings its fill forward and dims the rest');
        await shot('series-overview'); await setTheme(ev, 'light'); await shot('series-overview-light'); await setTheme(ev, 'dark');
        await view('team'); await waitFor(`document.querySelectorAll('#cost-series-team .viz-svg path.viz-line').length === 8`, 'the team chart again', 8000);
        console.log('   ✓');

        assert.equal(await ev(`document.getElementById('cost-compare-text').textContent`), '', 'the comparison with the prior period is the Overview\'s: no other view says it');
        console.log('2. Metrics: any of them together, one chart each; the rows add up to every chart; the last one cannot be switched off');
        const metric = name => ev(`[...document.querySelectorAll('#cost-series-team .viz-seg')[0].querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(name)}).click(); true`);
        const titles = () => ev(`[...document.querySelectorAll('#cost-series-team .viz-title')].map(h => h.textContent)`);
        const pressed = () => ev(`[...document.querySelectorAll('#cost-series-team .viz-seg')[0].querySelectorAll('button[aria-pressed="true"]')].map(b => b.textContent)`);
        assert.match(await ev(`document.querySelector('#cost-series-team .viz-check').textContent`), /^✓ Totals agree/);
        assert.equal(await ev(`document.querySelector('#cost-series-team .viz-check b span').getAttribute('aria-hidden')`), 'true', 'the check mark is drawn, not read (#8022): the words say it');
        await metric('Input');
        assert.deepEqual(await pressed(), ['Cost', 'Input']); assert.deepEqual(await titles(), ['Cost, running total', 'Input, running total'], 'several metrics, several rows: a chart for each');
        assert.match(await ev(`document.querySelector('#cost-series-team .viz-check').textContent`), /^✓ Totals agree The table's rows add up to what each chart ends on \(Cost and Input\)/);
        await metric('Cost');
        assert.deepEqual(await pressed(), ['Input']); assert.match(await ev(`document.querySelector('#cost-series-team .viz-check').textContent`), /^✓ Totals agree/);
        await metric('Input'); assert.deepEqual(await pressed(), ['Input'], 'the last metric stays on');
        await metric('Requests'); await metric('Input');
        assert.deepEqual(await titles(), ['Requests, running total']); assert.equal(await ev(`!!document.querySelector('#cost-series-team .viz-check')`), false, 'By team has no Requests column: no claim');
        await ev(`[...document.querySelectorAll('#cost-series-team .viz-seg')[1].querySelectorAll('button')].find(b => /^Each/.test(b.textContent)).click(); true`);
        assert.deepEqual(await titles(), ['Requests, each hour']);
        await metric('Cost'); await metric('Requests');
        console.log('   ✓');

        console.log('2b. The swatch is the switch of the row\'s line: left out, shown alone, put back; the colours do not move; the choice survives a refresh; Show the top 7 restores');
        const toggle = i => ev(`document.querySelectorAll('#cost-by-team .cost-toggle')[${i}].click(); true`);
        await toggle(1); // hub-team off
        let l2 = await lines();
        assert.deepEqual(l2.map(x => x.stroke), ['var(--viz-1)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)', 'var(--viz-7)'], 'six lines, each the colour it had: ' + JSON.stringify(l2));
        assert.equal(await ev(`document.querySelectorAll('#cost-by-team .cost-swatch-off').length`), 3, 'the row left out and the two that were in Other are empty rings');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-by-team .cost-toggle')].slice(0, 3).map(b => b.getAttribute('aria-pressed'))`), ['true', 'false', 'true']);
        assert.match(await ev(`document.querySelector('#cost-series-team .viz-hint').textContent`), /^Showing 6 of 9 rows\. Show the top 7/);
        assert.match(await ev(`document.querySelector('#cost-series-team .viz-check').textContent`), /^✓ Totals agree/, 'the rows shown add up to the chart');
        await toggle(1); // back: the default again, Other too
        assert.equal((await lines()).length, 8, 'the top 7 chosen again is the default');
        await toggle(8); // a row in Other: shown alone, in the first colour
        l2 = await lines(); assert.deepEqual(l2.map(x => x.stroke), ['var(--viz-1)'], JSON.stringify(l2));
        assert.equal(await ev(`document.querySelectorAll('#cost-by-team .cost-toggle')[8].firstChild.style.background`), 'var(--viz-1)');
        await toggle(0); await toggle(2);
        l2 = await lines(); assert.deepEqual(l2.map(x => x.stroke).sort(), ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)'].sort().length ? l2.map(x => x.stroke).sort() : [], JSON.stringify(l2));
        assert.equal(l2.length, 3, 'three rows on: ' + JSON.stringify(l2));
        // the period changes: the choice stays
        await ev(`(() => { const s = document.getElementById('cost-time-range'); s.value = 'week'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`document.querySelectorAll('#cost-series-team .viz-svg path.viz-line').length === 3 && document.querySelectorAll('#cost-by-team .cost-toggle[aria-pressed="true"]').length === 3`, 'the choice kept through the period change', 12000);
        // one row, several metrics: the metrics are the lines (tokens together, in their own colours), titled with the row
        await ev(`[...document.querySelectorAll('#cost-series-team .viz-hint button')].find(b => /top 7/.test(b.textContent)).click(); true`);
        await waitFor(`document.querySelectorAll('#cost-series-team .viz-svg path.viz-line').length === 8`, 'the top 7 again', 5000);
        await toggle(8); // design-sys alone (Other's first)
        for (const m of ['Input', 'Output', 'Cache read', 'Cache write']) await metric(m);
        await metric('Cost'); // Cost off: the four token metrics are left
        const one = await ev(`({ titles: [...document.querySelectorAll('#cost-series-team .viz-title')].map(h => h.textContent), strokes: [...document.querySelectorAll('#cost-series-team .viz-svg path.viz-line')].map(p => p.getAttribute('stroke')) })`);
        assert.deepEqual(one.titles, ['design-sys: Input, Output, Cache read and Cache write, each hour'], JSON.stringify(one));
        assert.deepEqual(one.strokes, ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)'], 'a line per metric in the metric\'s own colour');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-series-team .viz-legend-item .viz-legend-name')].map(e => e.textContent)`), ['Input', 'Output', 'Cache read', 'Cache write'], 'a key names each metric line');
        assert.match(await ev(`document.querySelector('#cost-series-team .viz-check').textContent`), /^✓ Totals agree/);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-series-team .viz-seg')[0].querySelectorAll('button[aria-pressed="true"]')].map(b => getComputedStyle(b, '::before').content)`), Array(4).fill('"✓" / ""'), 'each chosen metric wears a check mark');
        await shot('series-metrics-one-row');
        assert.equal(await ev(`document.querySelectorAll('#cost-series-team .viz-seg').length`), 3, 'Metrics, Show and, for one row with several metrics, Scale');
        await ev(`[...document.querySelectorAll('#cost-series-team .viz-seg')[2].querySelectorAll('button')].find(b => b.textContent === 'Log').click(); true`);
        const lg = await ev(`({ scale: document.querySelector('#cost-series-team .viz-svg').getAttribute('data-scale'), ticks: [...document.querySelectorAll('#cost-series-team .viz-svg text.viz-axis')].map(t => t.textContent).slice(0, 5) })`);
        assert.equal(lg.scale, 'log'); assert.deepEqual(lg.ticks.slice(0, 4), ['0', '10', '100', '1K'], 'a log axis steps by powers of ten: ' + JSON.stringify(lg));
        await shot('series-metrics-one-row-log');
        await ev(`[...document.querySelectorAll('#cost-series-team .viz-seg')[2].querySelectorAll('button')].find(b => b.textContent === 'Linear').click(); true`);
        await ev(`[...document.querySelectorAll('#cost-series-team .viz-hint button')].find(b => /top 7/.test(b.textContent)).click(); true`);
        await ev(`[...document.querySelectorAll('#cost-series-team .viz-seg')[1].querySelectorAll('button')].find(b => /^Running/.test(b.textContent)).click(); true`);
        await metric('Cost'); for (const m of ['Input', 'Output', 'Cache read', 'Cache write']) await metric(m); // back to Cost alone
        assert.deepEqual(await pressed(), ['Cost']);
        console.log('   ✓');

        console.log('3. A click on a row brings its line forward and dims the rest; again puts it back');
        await ev(`document.querySelectorAll('#cost-by-team tbody tr')[1].querySelector('td:nth-child(2)').click(); true`);
        let h = await lines();
        const front = h.filter(x => x.w === '3.5'); assert.deepEqual(front.map(x => x.stroke), ['var(--viz-2)'], JSON.stringify(h)); assert.equal(h[h.length - 1].stroke, 'var(--viz-2)', 'it is drawn last, in front'); assert.equal(h.filter(x => x.o === '0.2').length, 7, 'the rest dim');
        assert.equal(await ev(`document.querySelectorAll('#cost-by-team .cost-toggle')[1].classList.contains('cost-toggle-front')`), true);
        await ev(`document.querySelectorAll('#cost-by-team tbody tr')[1].querySelector('td:nth-child(2)').click(); true`);
        h = await lines(); assert.ok(h.every(x => x.o === '1' && x.w === '2'), JSON.stringify(h));
        await ev(`document.querySelectorAll('#cost-by-team tbody tr')[8].querySelector('td:nth-child(2)').click(); true`);
        h = await lines(); assert.deepEqual(h.filter(x => x.w === '3.5').map(x => x.stroke), ['var(--viz-other)'], 'a row in Other brings Other forward');
        await ev(`document.querySelectorAll('#cost-by-team tbody tr')[8].querySelector('td:nth-child(2)').click(); true`);
        console.log('   ✓');

        console.log('4. The tooltip names the lines at the time under the pointer');
        const tip = await ev(`(() => { const r = document.querySelector('#cost-series-team .viz-svg rect:last-of-type'); const b = r.getBoundingClientRect(); r.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: b.left + b.width / 2, clientY: b.top + 40 })); const t = document.querySelector('#cost-series-team .viz-tip'); return { hidden: t.hidden, rows: [...t.querySelectorAll('.viz-tip-row')].map(x => x.textContent), when: t.querySelector('.viz-tip-when').textContent }; })()`);
        assert.equal(tip.hidden, false); assert.equal(tip.rows.length, 6, JSON.stringify(tip)); assert.match(tip.rows[0], /^coral-go-team/); assert.ok(tip.when.length > 3);
        console.log('   ✓');

        console.log('5. By agent has its chart too, and a chart that is unavailable leaves the table whole');
        await view('agent');
        await waitFor(`document.querySelectorAll('#cost-series-agent .viz-svg path.viz-line').length === 2`, 'the agent lines', 10000);
        await ev(`window.__fail = true; true`); await view('team'); await ev(`import(${MOD} + 'cost_dashboard.js').then(m => m._refreshCostDashboard()).then(() => true)`);
        await waitFor(`/unavailable/.test(document.getElementById('cost-series-team').textContent) && document.querySelectorAll('#cost-by-team tbody tr').length === ${NAMES.length}`, 'the message and the whole table', 10000);
        console.log('   ✓');

        console.log('5b. By provider and By model: the same panel, the totals agree (Requests too: they have the column)');
        await ev(`window.__fail = false; true`);
        for (const [v, n] of [['provider', 2], ['model', 2]]) {
            await view(v); await waitFor(`document.querySelectorAll('#cost-series-${v} .viz-svg path.viz-line').length === ${n} && document.querySelectorAll('#cost-by-${v} .cost-swatch').length === ${n}`, `${v}: the lines and swatches`, 10000);
            assert.match(await ev(`document.querySelector('#cost-series-${v} .viz-check').textContent`), /^✓ Totals agree/, v);
            await ev(`[...document.querySelectorAll('#cost-series-${v} .viz-seg')[0].querySelectorAll('button')].find(b => b.textContent === 'Requests').click(); true`);
            assert.match(await ev(`document.querySelector('#cost-series-${v} .viz-check').textContent`), /^✓ Totals agree/, v + ' requests');
        }
        console.log('   ✓');

        console.log('6. A phone: the chart fits, no end labels, the swatches are targets, the table is one line a row');
        await open(390, 844, true);
        await waitFor(`document.querySelector('#cost-by-team .dt-box').classList.contains('dt-one-line')`, 'the table is one line a row', 6000);
        const p = await ev(`(() => { const box = document.querySelector('#cost-series-team .viz-chart'), s = box.querySelector('svg'); const sw = document.querySelector('#cost-by-team .cost-toggle').getBoundingClientRect();
            return { page: document.documentElement.scrollWidth > innerWidth + 1, svgW: Math.round(s.getBoundingClientRect().width), boxW: Math.round(box.clientWidth), ends: s.querySelectorAll('.viz-end').length, sw: Math.round(Math.min(sw.width, sw.height)), swTag: document.querySelector('#cost-by-team .cost-toggle').tagName, metricRows: new Set([...document.querySelectorAll('#cost-series-team .viz-seg')[0].querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().top))).size, seg: Math.round(document.querySelector('#cost-series-team .viz-seg button').getBoundingClientRect().height), folded: document.querySelector('#cost-by-team .dt-box').classList.contains('dt-folded'), oneLine: document.querySelector('#cost-by-team .dt-box').classList.contains('dt-one-line') }; })()`);
        assert.equal(p.metricRows, 1, 'the Metric segments are one row at 390: ' + JSON.stringify(p)); assert.equal(p.page, false, JSON.stringify(p)); assert.ok(p.svgW > 0 && p.boxW > 0 && p.svgW <= p.boxW + 1, JSON.stringify(p)); assert.equal(p.ends, 0, 'no end labels on a phone'); assert.ok(p.sw >= 44 && p.swTag === 'BUTTON', 'the switch is a 44 px button on a touch screen: ' + JSON.stringify(p)); assert.ok(p.seg >= 44, 'the pickers are 44 px: ' + JSON.stringify(p)); assert.equal(p.folded, false, 'one line a row, not folded (#8982)'); assert.ok(p.oneLine, 'the table is the one-line table');
        console.log('   ✓'); await shot('series-team-phone');
        await view('overview'); await waitFor(`document.querySelectorAll('#cost-series-overview .viz-fill').length === 8`, 'the Overview on a phone', 12000); await ev(`window.scrollTo(0, 0); true`); await shot('series-overview-phone'); await setTheme(ev, 'light'); await shot('series-overview-phone-light'); await setTheme(ev, 'dark');
        console.log('PASS analytics over time: lines, legend table, picker, highlight, tooltip, totals, phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
