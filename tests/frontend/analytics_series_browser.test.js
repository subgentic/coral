// The breakdown views over time (#7857): a line per table row above By team (and By agent, By provider, By model), the table as the legend (a swatch button, a row click), top 7 and Other, a metric picker, a
// running total or each hour, the tooltip, the "Totals agree" line, the phone, and a chart that is unavailable leaving the table whole. From stubbed /api/token-usage/* answers (the totals of the lines are the
// tables' totals, as the server's are). Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { setTheme } = require('./helpers/contrast');

const NAMES = ['coral-go-team', 'hub-team', 'docs-sprint', 'checkout-redesign', 'infra-ops', 'mobile-fix', 'research', 'qa-lab', 'design-sys'];
const TEAMS = NAMES.map((n, i) => ({ board_name: n, num_agents: 9 - i, input_tokens: (9 - i) * 1000, output_tokens: (9 - i) * 100, cache_read_tokens: (9 - i) * 5000, cache_write_tokens: (9 - i) * 10, cost_usd: (9 - i) * 1.5 }));
const AGENTS = [{ session_id: 'a1', agent_name: 'Frontend Dev', board_name: 'coral-go-team', folder: 'coral', requests: 12, input_tokens: 5000, output_tokens: 700, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 3.2, first_seen: '2026-10-21T05:00:00Z', last_seen: '2026-10-21T06:00:00Z' },
    { session_id: 'a2', agent_name: 'QA Engineer', board_name: 'coral-go-team', folder: 'coral', requests: 4, input_tokens: 900, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.6, first_seen: '2026-10-21T05:00:00Z', last_seen: '2026-10-21T05:30:00Z' }];
const PROVIDERS = [{ agent_type: 'claude', num_requests: 10, input_tokens: 9000, output_tokens: 900, cache_read_tokens: 100, cache_write_tokens: 10, cost_usd: 8 }, { agent_type: 'codex', num_requests: 6, input_tokens: 2000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 1.5 }];
const MODELS = [{ model: 'claude-opus-5-5', agent_type: 'claude', num_requests: 10, input_tokens: 9000, output_tokens: 900, cache_read_tokens: 100, cache_write_tokens: 10, cost_usd: 8 }, { model: 'gpt-5-codex', agent_type: 'codex', num_requests: 6, input_tokens: 2000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 1.5 }];
const tot = k => TEAMS.reduce((a, t) => a + t[k], 0);
// a day of hourly buckets whose lines add up to each row's figure
const series = (rows, key) => Array.from({ length: 24 }, (_, h) => ({ bucket: new Date(Date.now() - (23 - h) * 3600000).toISOString().replace(/:\d\d:\d\d\.\d+Z$/, ':00:00Z'), series: rows.map(r => ({ key: key(r), label: key(r),
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
            if (url.includes('/api/token-usage/timeseries')) { if (window.__fail) return json({}, 500); const g = new URL(url, location.origin).searchParams.get('group_by'); return json({ buckets: g === 'agent' ? ${JSON.stringify(series(AGENTS, r => r.agent_name))} : g === 'provider' ? ${JSON.stringify(series(PROVIDERS.map(r => ({ ...r, requests: r.num_requests })), r => r.agent_type))} : g === 'model' ? ${JSON.stringify(series(MODELS.map(r => ({ ...r, requests: r.num_requests })), r => r.model))} : ${JSON.stringify(series(TEAMS, r => r.board_name))}, interval: '1h' }); }
            if (url.includes('/api/token-usage/')) return json({});
            return R(u, o); }; ${extra} return true; })()`);
    const view = async key => { await ev(`import(${MOD} + 'analytics_views.js').then(m => { m.selectView(${JSON.stringify(key)}); return true; })`); };
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Emulation.setEmulatedMedia({ features: mobile ? [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] : [] });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await stub();
        await ev(`window.switchNavTab('tokens'); true`); await view('team');
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
        const sw = await ev(`[...document.querySelectorAll('#cost-by-team tbody tr')].map(r => { const b = r.querySelector('.cost-swatch'); return b ? [b.style.background, b.getAttribute('aria-label')] : null; })`);
        assert.equal(sw.filter(Boolean).length, NAMES.length, 'every row has its swatch: ' + JSON.stringify(sw));
        assert.match(sw[0][1], /^Bring coral-go-team's line forward$/);
        assert.equal(new Set(sw.slice(0, 7).map(s => s[0])).size, 7, 'seven rows, seven colours');
        assert.equal(sw[7][0], sw[8][0], 'the rows in Other share its colour');
        console.log('   ✓');

        for (const theme of ['dark', 'light']) { await setTheme(ev, theme); await ev(`document.querySelector('#cost-series-team').scrollIntoView({ block: 'start' }); true`); await shot(`series-team-${theme}`); }
        await setTheme(ev, 'dark');
        console.log('2. The rows add up to where the chart ends, said once; a figure the table does not have says nothing');
        assert.match(await ev(`document.querySelector('#cost-series-team .viz-check').textContent`), /^✓ Totals agree/);
        await ev(`[...document.querySelectorAll('#cost-series-team .viz-seg')[0].querySelectorAll('button')].find(b => b.textContent === 'Input').click(); true`);
        assert.match(await ev(`document.querySelector('#cost-series-team .viz-title').textContent`), /^Input, running total/);
        assert.match(await ev(`document.querySelector('#cost-series-team .viz-check').textContent`), /^✓ Totals agree/);
        await ev(`[...document.querySelectorAll('#cost-series-team .viz-seg')[0].querySelectorAll('button')].find(b => b.textContent === 'Requests').click(); true`);
        assert.equal(await ev(`!!document.querySelector('#cost-series-team .viz-check')`), false, 'By team has no Requests column: no claim');
        await ev(`[...document.querySelectorAll('#cost-series-team .viz-seg')[1].querySelectorAll('button')].find(b => /^Each/.test(b.textContent)).click(); true`);
        assert.match(await ev(`document.querySelector('#cost-series-team .viz-title').textContent`), /^Requests, each hour/);
        console.log('   ✓');

        console.log('3. A swatch, or a click on the row, brings a line forward and dims the rest; again puts it back');
        await ev(`[...document.querySelectorAll('#cost-series-team .viz-seg')[0].querySelectorAll('button')].find(b => b.textContent === 'Cost').click(); document.querySelectorAll('#cost-by-team .cost-swatch')[1].click(); true`);
        let h = await lines();
        const front = h.filter(x => x.w === '3.5'); assert.deepEqual(front.map(x => x.stroke), ['var(--viz-2)'], JSON.stringify(h)); assert.equal(h[h.length - 1].stroke, 'var(--viz-2)', 'it is drawn last, in front'); assert.equal(h.filter(x => x.o === '0.2').length, 7, 'the rest dim');
        assert.equal(await ev(`document.querySelectorAll('#cost-by-team .cost-swatch')[1].getAttribute('aria-pressed')`), 'true');
        await ev(`document.querySelectorAll('#cost-by-team .cost-swatch')[1].click(); true`);
        h = await lines(); assert.ok(h.every(x => x.o === '1' && x.w === '2'), JSON.stringify(h));
        await ev(`document.querySelectorAll('#cost-by-team tbody tr')[2].querySelector('td:nth-child(2)').click(); true`); // a click on the row (not its swatch or a link)
        h = await lines(); assert.deepEqual(h.filter(x => x.w === '3.5').map(x => x.stroke), ['var(--viz-3)'], 'the row click: ' + JSON.stringify(h));
        await ev(`document.querySelectorAll('#cost-by-team .cost-swatch')[8].click(); true`);
        h = await lines(); assert.deepEqual(h.filter(x => x.w === '3.5').map(x => x.stroke), ['var(--viz-other)'], 'a row in Other brings Other forward');
        await ev(`document.querySelectorAll('#cost-by-team .cost-swatch')[8].click(); true`);
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

        console.log('6. A phone: the chart fits, no end labels, the swatches are targets, the table folds');
        await open(390, 844, true);
        await waitFor(`document.querySelector('#cost-by-team .dt-box').classList.contains('dt-folded')`, 'the table folds', 6000);
        const p = await ev(`(() => { const box = document.querySelector('#cost-series-team .viz-chart'), s = box.querySelector('svg'); const sw = document.querySelector('#cost-by-team .cost-swatch').getBoundingClientRect();
            return { page: document.documentElement.scrollWidth > innerWidth + 1, svgW: Math.round(s.getBoundingClientRect().width), boxW: Math.round(box.clientWidth), ends: s.querySelectorAll('.viz-end').length, sw: Math.round(Math.min(sw.width, sw.height)), swTag: document.querySelector('#cost-by-team .cost-swatch').tagName, seg: Math.round(document.querySelector('#cost-series-team .viz-seg button').getBoundingClientRect().height), folded: document.querySelector('#cost-by-team .dt-box').classList.contains('dt-folded') }; })()`);
        assert.equal(p.page, false, JSON.stringify(p)); assert.ok(p.svgW <= p.boxW + 1, JSON.stringify(p)); assert.equal(p.ends, 0, 'no end labels on a phone'); assert.ok(p.sw >= 18 && p.swTag === 'SPAN', 'on a touch screen the swatch is only a colour (the 44 px row does the same): ' + JSON.stringify(p)); assert.ok(p.seg >= 44, 'the pickers are 44 px: ' + JSON.stringify(p)); assert.equal(p.folded, true);
        console.log('   ✓'); await shot('series-team-phone');
        console.log('PASS analytics over time: lines, legend table, picker, highlight, tooltip, totals, phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
