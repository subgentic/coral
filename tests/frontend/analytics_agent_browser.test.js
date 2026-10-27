// The agent drill-down (#7930): By agent's Charts link opens one agent over the range: tiles, cost turn by turn, cost each hour (a bar or the Turns in select picks an hour), the biggest turns of the pick as a
// table, Tool calls and Cache hit under More charts, a way back; the charts are aria-hidden with their text beside them; a read that fails leaves the rest. From stubbed /api/ answers. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { setTheme } = require('./helpers/contrast');

const AGENTS = [{ session_id: 'a1', agent_name: 'Frontend Dev', board_name: 'coral-go-team', folder: 'coral', requests: 120, input_tokens: 40000, output_tokens: 7000, cache_read_tokens: 360000, cache_write_tokens: 900, cost_usd: 24, first_seen: '2026-10-21T05:00:00Z', last_seen: '2026-10-21T06:00:00Z' },
    { session_id: 'a2', agent_name: 'QA Engineer', board_name: 'coral-go-team', folder: 'coral', requests: 4, input_tokens: 900, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.6, first_seen: '2026-10-21T05:00:00Z', last_seen: '2026-10-21T05:30:00Z' }];
const hourIso = ago => new Date(Math.floor((Date.now() - ago * 3600000) / 3600000) * 3600000).toISOString().replace('.000Z', 'Z');
const BUCKETS = Array.from({ length: 24 }, (_, h) => ({ bucket: hourIso(23 - h), series: [{ key: 'Frontend Dev', label: 'Frontend Dev', cost_usd: h === 20 ? 9 : 0.6, input_tokens: 1700, output_tokens: 300, cache_read_tokens: h === 20 ? 1000 : 15000, cache_write_tokens: 40, num_requests: 5 }, { key: 'QA Engineer', label: 'QA Engineer', cost_usd: 0.02, input_tokens: 30, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0, num_requests: 1 }] }));
const TURNS = Array.from({ length: 30 }, (_, i) => ({ turn: i + 1, cost_usd: i === 14 ? 6.6 : 0.6, cumulative_cost: 0, input_tokens: 1000, output_tokens: 100, cache_read_tokens: 9000, cache_write_tokens: 0, model: 'claude-opus-5-5', timestamp: new Date(Date.now() - (30 - i) * 600000).toISOString() })).map((t, i, a) => ({ ...t, cumulative_cost: a.slice(0, i + 1).reduce((s, x) => s + x.cost_usd, 0) }));
const BIGGEST = [{ session_id: 'a1', agent_name: 'Frontend Dev', cost_usd: 6, input_tokens: 38000, output_tokens: 900, cache_read_tokens: 1000, cache_write_tokens: 0, model: 'claude-opus-5-5', timestamp: new Date(Date.now() - 16 * 600000).toISOString(), num_turns: 1 },
    { session_id: 'a1', agent_name: 'Frontend Dev', cost_usd: 1.2, input_tokens: 9000, output_tokens: 300, cache_read_tokens: 4000, cache_write_tokens: 0, model: 'claude-opus-5-5', timestamp: new Date(Date.now() - 5 * 600000).toISOString(), num_turns: 1 }];
const CALLS = Array.from({ length: 24 }, (_, h) => ({ bucket: hourIso(23 - h), calls: 20 + h, errors: h === 20 ? 9 : 1, avg_duration_ms: 40 }));

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const stub = () => ev(`(() => { const R = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })); window.__urls = []; window.__fail = '';
        window.fetch = (u, o) => { const url = String(u && u.url || u); window.__urls.push(url);
            if (window.__fail && url.includes(window.__fail)) return json({}, 500);
            if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 40900, output_tokens: 7090, cost_usd: 24.6, num_requests: 124 }, by_agent_type: [], by_model: [], by_thinking: [], by_agent: ${JSON.stringify(AGENTS)} });
            if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
            if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
            if (url.includes('/api/token-usage/session/a1/turns')) return json({ turns: ${JSON.stringify(TURNS)} });
            if (url.includes('/api/token-usage/turns?')) return json({ turns: ${JSON.stringify(BIGGEST)} });
            if (url.includes('/api/token-usage/timeseries')) return json({ buckets: ${JSON.stringify(BUCKETS)}, interval: '1h' });
            if (url.includes('/api/call-metrics/summary')) return json({ hours: 24, interval: '1h', buckets: ${JSON.stringify(CALLS)} });
            if (url.includes('/api/token-usage/')) return json({});
            return R(u, o); }; return true; })()`);
    const view = key => ev(`import(${MOD} + 'analytics_views.js').then(m => { m.selectView(${JSON.stringify(key)}); return true; })`);
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Emulation.setEmulatedMedia({ features: mobile ? [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] : [] });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`); await stub();
        await ev(`window.switchNavTab('tokens'); true`); await view('agent');
        await waitFor(`document.querySelectorAll('#cost-by-agent tbody tr').length === 2`, 'the agents', 15000);
    };
    const detail = () => ev(`(() => { const h = document.getElementById('cost-agent-detail'); return { view: document.getElementById('cost-dashboard-view').dataset.view, title: document.getElementById('cost-view-title').textContent, svgs: [...h.querySelectorAll('.viz-svg')].map(s => [s.getAttribute('aria-hidden'), !s.closest('details:not([open])')]), tiles: [...h.querySelectorAll('.viz-tile')].map(t => t.textContent), rows: [...h.querySelectorAll('.dt-table tbody tr')].map(r => r.children[1].textContent.trim()), tableTitle: (h.querySelector('.viz-table-title') || {}).textContent, current: (document.querySelector('#cost-nav-list [aria-current="true"]') || {}).textContent }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await open(1280, 900, false);

        console.log('1. Charts on a By agent row opens that agent');
        // the rows have no floating chart any more (#7970): a pointer over a row draws nothing
        await ev(`document.querySelector('#cost-by-agent tbody tr').dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); true`);
        assert.equal(await ev(`document.querySelectorAll('.agent-cost-chart-tooltip').length`), 0, 'no floating chart over a row');
        await shot('agent-table');
        const links = await ev(`[...document.querySelectorAll('#cost-by-agent tbody tr .dt-link')].filter(b => /^Charts/.test(b.getAttribute('aria-label') || '')).map(b => b.getAttribute('aria-label'))`);
        assert.deepEqual(links, ['Charts for Frontend Dev', 'Charts for QA Engineer']);
        await ev(`document.querySelector('#cost-by-agent tbody tr .dt-link[aria-label="Charts for Frontend Dev"]').click(); true`);
        await waitFor(`document.querySelectorAll('#cost-agent-detail .viz-svg').length >= 3 && document.querySelectorAll('#cost-agent-detail .dt-table tbody tr').length === 2`, 'the drill-down', 12000);
        let d = await detail();
        assert.deepEqual([d.view, d.title, d.current], ['agent-detail', 'Frontend Dev', 'Overview'], JSON.stringify(d));
        assert.equal(await ev(`(() => { const b = document.querySelector('.viz-back'); return [b.querySelector('span').getAttribute('aria-hidden'), b.textContent]; })()`).then(x => x.join('|')), 'true|\u2190 Overview', 'the back link: its arrow is drawn, not read (#8022)');
        assert.ok(d.svgs.every(s => s[0] === 'true'), 'every chart is hidden from a screen reader: ' + JSON.stringify(d.svgs));
        assert.equal(d.svgs.filter(s => s[1]).length, 2, 'two charts lead; the rest are under More charts: ' + JSON.stringify(d.svgs));
        assert.deepEqual(d.rows, ['$6.00', '$1.20'], 'the biggest turns, the dearest first');
        const first = await ev(`({ title: document.querySelector('#cost-agent-detail .viz-title').textContent, sr: document.querySelector('#cost-agent-detail .viz-sr').textContent })`);
        assert.match(first.title, /^Cost turn by turn, last 24 hours/); assert.match(first.sr, /\$24\.00 in all/, 'the running cost ends on the Cost tile: ' + first.sr);
        assert.match(d.tiles[0], /^Cost\$24\.00/); assert.match(d.tiles[2], /90% of the input/, JSON.stringify(d.tiles));
        console.log('   ✓');

        console.log('2. A bar, or the select, picks an hour: the biggest turns are that hour\'s');
        const before = await ev(`window.__urls.filter(u => u.includes('/api/token-usage/turns?')).length`);
        await ev(`(() => { const r = [...document.querySelectorAll('#cost-agent-detail .viz-svg')][1].querySelectorAll('g')[20].querySelector('rect:last-of-type'); r.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
        await waitFor(`/^Biggest turns, (?!last)/.test(document.querySelector('#cost-agent-detail .viz-table-title').textContent)`, 'the title names the hour', 8000);
        const u = await ev(`window.__urls.filter(u => u.includes('/api/token-usage/turns?')).pop()`);
        const q = new URL(u, 'http://x').searchParams;
        assert.equal(q.get('agent'), 'Frontend Dev'); assert.equal(Date.parse(q.get('until')) - Date.parse(q.get('since')), 3600000, 'one hour: ' + u); assert.equal(q.get('order'), 'cost');
        assert.ok(await ev(`window.__urls.filter(u => u.includes('/api/token-usage/turns?')).length`) > before);
        assert.notEqual(await ev(`document.getElementById('cost-agent-window').value`), '', 'the select shows the pick');
        await ev(`(() => { const s = document.getElementById('cost-agent-window'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await waitFor(`/^Biggest turns, last 24 hours/.test(document.querySelector('#cost-agent-detail .viz-table-title').textContent)`, 'the whole range again', 8000);
        await shot('agent-detail'); await setTheme(ev, 'light'); await shot('agent-detail-light'); await setTheme(ev, 'dark');
        console.log('   ✓');

        console.log('3. More charts: tool calls (failed on top, in the error colour) and cache hit');
        await ev(`document.querySelector('#cost-agent-detail .viz-more summary').click(); true`);
        await waitFor(`document.querySelectorAll('#cost-agent-detail .viz-more .viz-svg').length === 2 && !!document.querySelector('#cost-agent-detail .viz-more[open]')`, 'both charts', 8000);
        assert.ok(await ev(`[...document.querySelectorAll('#cost-agent-detail .viz-more .viz-bar')].some(p => p.getAttribute('fill') === 'var(--danger)')`), 'failed calls are drawn in the error colour');
        console.log('   ✓');

        assert.equal(await ev(`document.querySelector('#cost-agent-detail .viz-back').textContent`), '\u2190 Overview'); assert.ok(await ev(`document.querySelector('#cost-agent-detail .viz-back').classList.contains('back-link')`), 'the back link of the page, not a button');
        console.log('4. Back to By agent; a failing read leaves the rest');
        await ev(`document.querySelector('#cost-agent-detail .viz-back').click(); true`);
        await waitFor(`document.getElementById('cost-dashboard-view').dataset.view === 'agent'`, 'back on By agent', 6000);
        await ev(`window.__fail = '/api/token-usage/session/'; true`);
        await ev(`document.querySelector('#cost-by-agent tbody tr .dt-link[aria-label="Charts for Frontend Dev"]').click(); true`);
        await waitFor(`/The turns are unavailable/.test(document.getElementById('cost-agent-detail').textContent) && document.querySelectorAll('#cost-agent-detail .dt-table tbody tr').length === 2`, 'the message and the other sections', 10000);
        console.log('   ✓');

        console.log('5. A phone: it fits and the pick is a 44 px select');
        await open(390, 844, true);
        const chartsLink = await ev(`(() => { const r = document.querySelector('#cost-by-agent tbody tr .dt-link[aria-label="Charts for Frontend Dev"]').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
        assert.ok(chartsLink[0] >= 44 && chartsLink[1] >= 44, 'the Charts link is a 44 px target both ways on a phone (#8022): ' + chartsLink);
        await ev(`document.querySelector('#cost-by-agent tbody tr .dt-link[aria-label="Charts for Frontend Dev"]').click(); true`);
        await waitFor(`document.querySelectorAll('#cost-agent-detail .viz-svg').length >= 3`, 'the drill-down on a phone', 12000);
        const p = await ev(`({ page: document.documentElement.scrollWidth > innerWidth + 1, sel: Math.round(document.getElementById('cost-agent-window').getBoundingClientRect().height), back: Math.round(document.querySelector('#cost-agent-detail .viz-back').getBoundingClientRect().height) })`);
        assert.equal(p.page, false, JSON.stringify(p)); assert.ok(p.sel >= 44, JSON.stringify(p));
        await shot('agent-detail-phone'); await setTheme(ev, 'light'); await shot('agent-detail-phone-light'); await setTheme(ev, 'dark');
        console.log('   ✓');
        console.log('PASS analytics agent drill-down: tiles, cost by turn and hour, the pick, biggest turns, more charts, back, failures, phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
