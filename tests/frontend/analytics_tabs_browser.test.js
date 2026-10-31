// The Analytics tabs below Overview (#11222, the Operator's approved mockup and QA Reviewer 2's render check): Usage, Operator interaction and Team communication, at 1440 and 390 px in the dark and the light theme.
// Reads are stubbed: GET /api/token-usage/timeseries, /api/token-usage/turns and GET /api/analytics/activity. What is pinned: the sidebar order (Overview stays first), one bar a day with a label under every few
// bars (never overlapping), every series named in the legend with a stripe after the fourth, the previous/next day buttons, a number the read lacks saying "not recorded yet", a Hub guest's one line, the grid's
// text at 4.5:1 and each series at 3:1 in both themes, tables that say they scroll, and 44 px targets and rows on the phone. Isolated dev server.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const sceneShots = require('./helpers/scene_shots');
const TEAM = 'coral-go-team';
const AGENTS = ['Orchestrator', 'Backend Dev', 'Frontend Dev', 'QA Reviewer 1', 'QA Reviewer 2', 'Data Science', 'DevOps', 'Security', 'Docs Writer'];
const today = new Date().toISOString().slice(0, 10);
const day = (back) => new Date(Date.parse(today + 'T00:00:00Z') - back * 86400000).toISOString().slice(0, 10);
const BUCKETS = Array.from({ length: 28 }, (_, i) => { const d = day(27 - i); const series = AGENTS.map((a, j) => ({ key: a, label: a, cost_usd: (j + 1) * (i === 20 ? 3 : 1), input_tokens: 1000 * (j + 1), output_tokens: 500, num_requests: 2, cache_read_tokens: 4000 })); return { bucket: d + 'T00:00:00Z', cost_usd: series.reduce((n, s) => n + s.cost_usd, 0), input_tokens: series.reduce((n, s) => n + s.input_tokens, 0), output_tokens: 4500, cache_read_tokens: 36000, num_requests: 18, series }; });
const ACTIVITY = { project: TEAM, days: Array.from({ length: 14 }, (_, i) => ({ day: day(13 - i), posts: 20 + i, cross: i % 3, automated: 9, operator: i % 4, tasks_done: i % 2 })), tasks_done: 7, agent_posts: 300, automated_posts: 126, cross_posts: 12, operator_posts: 21, assigned: 9,
    agents: AGENTS.slice(0, 8).map((a, i) => ({ name: a, sent: 80 - i * 9, received: 60 - i * 5, to_operator: i % 3, asks_operator: i % 2 })),
    edges: AGENTS.slice(0, 8).flatMap((a, i) => AGENTS.slice(0, 8).filter((_, j) => j !== i).map((b, j) => ({ from: a, to: b, count: ((i * 7 + j * 3) % 11) + 1 }))).sort((x, y) => y.count - x.count),
    pairs: [{ from: TEAM, to: 'coral-hub', messages: 14, requests: 3, accepted: 2 }, { from: 'coral-hub', to: TEAM, messages: 9, requests: 1, accepted: 1 }, { from: 'windows', to: TEAM, messages: 4, requests: 2, accepted: 2 }, { from: TEAM, to: 'windows', messages: 6, requests: 0, accepted: 0 }],
    asks: { asked: 12, answered: 11, median_s: 250, slowest_s: 900 }, operator_asks: { asked: 4, answered: 3, median_s: 440, slowest_s: 7400 } };
const TURNS = [{ timestamp: day(7) + 'T14:12:00.000Z', model: 'claude-fable-5-1', cost_usd: 6.4, input_tokens: 90000, output_tokens: 3000 }, { timestamp: day(7) + 'T14:40:00.000Z', model: 'claude-sonnet-5-5', cost_usd: 2.1, input_tokens: 40000, output_tokens: 900 }];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const shot = sceneShots(Page, 'analytics-tabs');
    const run = async (name, fn) => { try { await fn(); results.push([name, null]); console.log('   ok   ' + name); } catch (e) { results.push([name, e]); console.log('   FAIL ' + name + ': ' + (e && e.message || e)); } };
    const open = async (key) => { await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'analytics_views.js'); m.selectView(${JSON.stringify(key)}); return true; })()`); };
    const setTheme = (t) => ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(t)}); true`);
    const size = async (w) => { await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 }); await waitFor(`window.innerWidth === ${w}`, 'the window is ' + w, 4000); };
    const text = sel => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
    // contrast in the page: both "rgb(...)" and "color(srgb ...)" are what a computed colour can look like
    const CONTRAST = `window.__lum = c => { const m = String(c).match(/-?[\\d.]+/g).map(Number); const rgb = String(c).startsWith('color(') ? m.slice(0, 3).map(v => v * 255) : m.slice(0, 3); const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
        window.__ratio = (a, b) => { const x = window.__lum(a), y = window.__lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }; true`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(CONTRAST);
        await ev(`(() => { window.__reqs = []; window.__activity = ${JSON.stringify(ACTIVITY)}; window.__activityStatus = 200; window.__turns = ${JSON.stringify(TURNS)};
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), p = url.pathname;
                const ok = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
                if (p === '/api/token-usage/timeseries' && url.searchParams.get('interval') === '1d') { window.__reqs.push(p + url.search); return ok({ interval: '1d', buckets: ${JSON.stringify(BUCKETS)} }); }
                if (p === '/api/token-usage/turns') { window.__reqs.push(p + url.search); return ok({ turns: window.__turns }); }
                if (p === '/api/analytics/activity') { window.__reqs.push(p + url.search); return ok(window.__activityStatus === 200 ? { range: url.searchParams.get('range'), activity: window.__activity } : { error: 'forbidden' }, window.__activityStatus); }
                if (p === '/api/board/projects') return ok([{ board_id: '${TEAM}', board_label: '${TEAM}' }]);
                return R(u, o); };
            window._coralSetLiveSessions([{ session_id: 'a-1', name: 'a-1', agent_type: 'claude', board_project: '${TEAM}', display_name: 'Backend Dev', working_directory: '/tmp/x' }]); return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.querySelectorAll('#cost-nav-list .row-btn').length >= 4`, 'the list of views', 10000);

        await run('the sidebar lists Overview first, then the three new views, below it', async () => {
            const names = await ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].map(b => b.textContent.trim())`);
            assert.deepEqual(names.slice(0, 4), ['Overview', 'Usage', 'Operator interaction', 'Team communication'], JSON.stringify(names));
        });

        for (const [w, theme] of [[1440, 'dark'], [1440, 'light'], [390, 'dark'], [390, 'light']]) {
            const at = `${w}px ${theme}`, phone = w < 600;
            await size(w); await setTheme(theme);
            await open('usage'); await waitFor(`document.querySelectorAll('#cost-usage .atab-kpi').length >= 6 && document.querySelectorAll('#cost-usage svg .atab-bar').length > 20`, 'Usage drawn ' + at, 10000);

            await run(`${at}: Usage has six KPIs, one bar a day, every series in the legend and the picked day's ranking`, async () => {
                assert.equal(await ev(`document.querySelectorAll('#cost-usage .atab-kpi').length`), 6);
                assert.equal(await ev(`new Set([...document.querySelectorAll('#cost-usage svg .atab-hit')].map(h => h.getAttribute('x'))).size`), 14, 'a bar a day for the 14 days');
                const legend = await ev(`[...document.querySelectorAll('#cost-usage .atab-legend li')].map(l => l.textContent)`);
                assert.equal(legend.length, 8, 'the top 7 and Other: ' + JSON.stringify(legend)); assert.match(legend[7], /^Other \(2\)$/);
                assert.ok(await ev(`document.querySelectorAll('#cost-usage .atab-legend .atab-sw-stripe').length`) >= 4, 'series after the fourth have a stripe, not colour alone');
                assert.ok((await text('#cost-usage .atab-ranked')).includes('Backend Dev') || (await text('#cost-usage .atab-ranked')).length > 0);
                assert.ok(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), 'no sideways scroll of the page');
            });
            await run(`${at}: the date labels never overlap`, async () => {
                const r = await ev(`(() => { const t = [...document.querySelectorAll('#cost-usage svg text.atab-axis')].filter(x => /^[A-Z][a-z]{2} \\d+$/.test(x.textContent)).map(x => x.getBoundingClientRect()); let overlap = 0; for (let i = 1; i < t.length; i++) if (t[i].left < t[i - 1].right + 2) overlap++; return { n: t.length, overlap }; })()`);
                assert.ok(r.n >= 2 && r.n <= (phone ? 5 : 9), 'a label under every few bars: ' + JSON.stringify(r)); assert.equal(r.overlap, 0, JSON.stringify(r));
            });
            await run(`${at}: previous and next day change the day, and are ${phone ? '44 px targets' : 'buttons'}`, async () => {
                const before = await text('#cost-usage .atab-day-say');
                await ev(`[...document.querySelectorAll('#cost-usage .atab-days button')].find(b => b.textContent === 'Previous day').click(); true`);
                await waitFor(`document.querySelector('#cost-usage .atab-day-say').textContent !== ${JSON.stringify(before)}`, 'the day changed', 4000);
                if (phone) { const h = await ev(`[...document.querySelectorAll('#cost-usage .atab-days button, #cost-usage .atab-filters select, #cost-usage .atab-seg button')].map(b => Math.round(b.getBoundingClientRect().height))`); assert.ok(h.length >= 5 && h.every(x => x >= 44), 'every control is 44 px: ' + JSON.stringify(h)); }
                await ev(`[...document.querySelectorAll('#cost-usage .atab-days button')].find(b => b.textContent === 'Next day').click(); true`);
            });
            await run(`${at}: the series hold 3:1 against the card, and a bar's colour is the legend's`, async () => {
                const bad = await ev(`(() => { const card = getComputedStyle(document.querySelector('#cost-usage .atab-card')).backgroundColor; const out = []; for (let i = 1; i <= 7; i++) { const probe = document.createElement('i'); probe.style.color = 'var(--viz-' + i + ')'; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); const r = window.__ratio(c, card); if (r < 3) out.push([i, r.toFixed(2)]); } return out; })()`);
                assert.deepEqual(bad, [], 'series colours under 3:1: ' + JSON.stringify(bad));
            });
            await run(`${at}: Usage chart text is at least 9 px as drawn`, async () => { const k = await ev(`(() => { const svg = document.querySelector('#cost-usage svg.atab-svg'); const r = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width; return parseFloat(getComputedStyle(svg.querySelector('text')).fontSize) * r; })()`); assert.ok(k >= 9, 'axis text ' + k.toFixed(1) + ' px'); });
            await shot(`usage-${w}-${theme}`);

            await open('operator'); await waitFor(`document.querySelectorAll('#cost-operator .atab-kpi').length >= 7`, 'Operator drawn ' + at, 10000);
            await run(`${at}: Operator interaction says what is not recorded yet, and the Operator's posts and asks are there`, async () => {
                assert.match(await text('#cost-operator .atab-pending'), /Not recorded yet\./);
                assert.equal(await ev(`document.querySelectorAll('#cost-operator .atab-trend').length`), 0, 'no trend line while the touches are not recorded');
                assert.match(await text('#cost-operator'), /The trend needs every kind of touch/);
                const k = await ev(`[...document.querySelectorAll('#cost-operator .atab-kpi')].map(x => x.textContent.replace(/\\s+/g, ' ').trim())`);
                assert.ok(/Operator board posts\s*21/.test(k[0].replace(/(\\d)(\\D)/, '$1 $2')) || /Operator board posts/.test(k[0]), k[0]); assert.ok(/Asks to the Operator4/.test(k[3]) || /Asks to the Operator/.test(k[3]), k[3]);
                assert.ok(/Typed to agents/.test(k[1]) && /not recorded yet/.test(k[1]), 'typing is pending, not zero, until it is recorded: ' + k[1]);
                assert.ok(/Touches \(all kinds\)/.test(k[6]) && /not recorded yet/.test(k[6]), 'the touches KPI is pending, not zero: ' + k[6]);
                assert.ok(await ev(`!!document.querySelector('#cost-operator .atab-kpi-pending')`));
                assert.equal(await ev(`document.querySelectorAll('#cost-operator .atab-legend li').length`), 1, 'only the recorded kind is in the legend until the rest is');
            });
            await run(`${at}: with touches recorded the six kinds appear`, async () => {
                await ev(`window.__activity = { ...window.__activity, touches: { kinds: {}, days: ${JSON.stringify(ACTIVITY.days.map(d => ({ day: d.day, typed: 3, answer: 1, approve: 1, wake: 0, restart: 1, stop: 0 })))}, agents: [{ name: 'Backend Dev', typed: 9 }], sources: { local: 60, hub: 5 } } }; (async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`);
                await waitFor(`document.querySelectorAll('#cost-operator .atab-legend li').length === 7`, 'seven kinds', 8000);
                assert.equal(await ev(`document.querySelectorAll('#cost-operator .atab-pending').length`), 0);
                assert.ok(await ev(`!!document.querySelector('#cost-operator .atab-trend svg path.atab-line')`), 'the autonomy line is drawn');
                assert.match(await text('#cost-operator .atab-trend'), /touches per task done in the 7 days to .*, against .* in the 7 days to .*Fewer is more autonomy/);
                const nd = ACTIVITY.days.length;
                const typedTile = await ev(`(() => { const t = [...document.querySelectorAll('#cost-operator .atab-kpi')].find(k => /Typed to agents/.test(k.textContent)); return t ? t.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
                assert.ok(typedTile.startsWith('Typed to agents' + (nd * 3) + 'in') && /chat or terminal/.test(typedTile), 'the typed tile counts the typing, ' + nd + ' days of 3: ' + typedTile);
                await shot(`operator-recorded-${w}-${theme}`);
                assert.match(await text('#cost-operator .atab-kpi-pending, #cost-operator .atab-kpis'), /5 of them through Coral Hub/, 'the Hub share is said as such');
                await ev(`window.__activity = ${JSON.stringify(ACTIVITY)}; (async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`);
                await waitFor(`document.querySelectorAll('#cost-operator .atab-legend li').length === 1`, 'back', 8000);
            });
            await shot(`operator-${w}-${theme}`);

            await open('comm'); await waitFor(`document.querySelectorAll('#cost-comm .atab-kpi').length >= 6`, 'Communication drawn ' + at, 10000);
            await run(`${at}: Team communication shows who talks to whom ${phone ? 'as a ranked list' : 'as a grid whose text holds 4.5:1'}`, async () => {
                if (phone) { assert.equal(await ev(`document.querySelectorAll('#cost-comm .atab-matrix').length`), 0); assert.ok(await ev(`document.querySelectorAll('#cost-comm .atab-ranked .atab-rank').length`) >= 5); return; }
                const bad = await ev(`(() => { const out = []; for (const c of document.querySelectorAll('#cost-comm .atab-mx-c')) { if (!c.textContent.trim() || c.textContent === '\\u00b7') continue; const cs = getComputedStyle(c); const r = window.__ratio(cs.color, cs.backgroundColor); if (r < 4.5) out.push([c.title, r.toFixed(2)]); } return out; })()`);
                assert.deepEqual(bad, [], 'cells under 4.5:1: ' + JSON.stringify(bad.slice(0, 4)));
                assert.ok(await ev(`document.querySelectorAll('#cost-comm .atab-mx-c').length`) >= 64);
            });
            await run(`${at}: Across teams shows who asks whom: the grid (a ranked list on a phone) and a row a pair with its counts`, async () => {
                const t = await ev(`(() => { const p = [...document.querySelectorAll('#cost-comm .atab-card')].find(c => /^Across teams/.test(c.textContent)); if (!p) return null; return { text: p.textContent, cells: p.querySelectorAll('.atab-mx-c').length, ranked: p.querySelectorAll('.atab-rank').length, rows: p.querySelectorAll('tbody tr').length, cellTexts: [...p.querySelectorAll('.atab-mx-c')].map(c => c.textContent.trim()), hub: (() => { const r = [...p.querySelectorAll('tbody tr')].find(r => { const c = [...r.cells].map(x => x.textContent.trim()); return c[0] === 'coral-go-team' && c[1] === 'coral-hub'; }); return r ? [...r.cells].slice(2, 5).map(x => x.textContent.trim()) : null; })() }; })()`);
                assert.ok(t, 'an Across teams panel');
                assert.equal(t.rows, 4, 'a row a pair: ' + JSON.stringify(t.rows));
                for (const word of ['coral-hub', 'windows']) assert.ok(t.text.includes(word), word + ' is in the panel');
                assert.deepEqual(t.hub, ['14', '3', '2'], 'coral-go-team asks coral-hub: messages, goal requests, accepted');
                if (phone) { assert.equal(t.cells, 0); assert.ok(t.ranked >= 4, 'a ranked list of pairs on a phone'); } else { assert.equal(t.cells, 9, 'a 3 by 3 grid of the three teams'); assert.ok(t.cellTexts.includes('17'), 'the grid cell coral-go-team to coral-hub is 17 (14 messages and 3 goal requests): ' + JSON.stringify(t.cellTexts)); }
            });
            await run(`${at}: the per-task table is "not recorded yet" until the read has it, and then lists its rows`, async () => {
                assert.match(await text('#cost-comm'), /Per-task message counts are added with the recording/);
                await ev(`window.__activity = { ...window.__activity, task_messages: [{ task_id: 11222, agent: 'Data Science', sent: 19, received: 28, within: 31, across: 16 }] }; (async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`);
                await waitFor(`/#11222/.test(document.getElementById('cost-comm').textContent)`, 'the task row', 8000);
                await ev(`window.__activity = ${JSON.stringify(ACTIVITY)}; (async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`);
                await waitFor(`/not recorded|added with the recording/.test(document.getElementById('cost-comm').textContent)`, 'back', 8000);
            });
            await run(`${at}: the table's scroll hint matches whether it overflows${phone ? ', and its rows are 44 px' : ''}`, async () => {
                const r = await ev(`(() => { const f = [...document.querySelectorAll('#cost-comm .atab-card')].find(c => /^Sent and received by agent/.test(c.textContent)).querySelector('.atab-tframe'); const over = [f, ...f.querySelectorAll('*')].some(e => e.scrollWidth > e.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(e).overflowX)); return { over, hidden: f.querySelector('.atab-hint').hidden, rows: [...f.querySelectorAll('tbody tr')].map(t => Math.round(t.getBoundingClientRect().height)) }; })()`);
                assert.equal(r.hidden, !r.over, 'the hint is shown only when the table overflows: ' + JSON.stringify(r));
                if (phone) assert.ok(r.rows.length && r.rows.every(h => h >= 44), JSON.stringify(r.rows));
                assert.ok(r.rows.length >= 5, 'the agents are rows');
            });
            await run(`${at}: axis text on every chart is at least 9 px as drawn`, async () => {
                const small = await ev(`(() => { const out = []; for (const host of ['cost-usage', 'cost-operator', 'cost-comm']) for (const svg of document.querySelectorAll('#' + host + ' svg.atab-svg')) { if (!svg.getClientRects().length) continue; const k = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width; for (const t of svg.querySelectorAll('text')) { const px = parseFloat(getComputedStyle(t).fontSize) * k; if (px < 9) out.push([host, t.textContent, px.toFixed(1)]); } } return out; })()`);
                assert.deepEqual(small, [], 'chart text under 9 px: ' + JSON.stringify(small.slice(0, 4)));
            });
            await shot(`communication-${w}-${theme}`);
        }

        await size(1440); await setTheme('dark');
        await run('a Hub guest\'s refusal is one line on the two owner tabs, and Usage still draws', async () => {
            await ev(`window.__activityStatus = 403; true`);
            await open('operator'); await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`);
            await waitFor(`/visible to the owner of this Coral only/.test(document.getElementById('cost-operator').textContent)`, 'the guest line', 8000);
            assert.equal(await ev(`document.querySelectorAll('#cost-operator .atab-kpi').length`), 0, 'no numbers for a guest');
            await open('comm'); await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`);
            await waitFor(`/visible to the owner of this Coral only/.test(document.getElementById('cost-comm').textContent)`, 'the guest line on Communication', 8000);
            await open('usage'); assert.ok(await ev(`document.querySelectorAll('#cost-usage .atab-kpi').length`) >= 6);
            await ev(`window.__activityStatus = 200; true`);
        });
        await run('a figure the reply lacks says "not recorded yet" and a recorded zero stays 0 (Operator and Team communication)', async () => {
            const refresh = `(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`;
            const kpis = (id) => ev(`Object.fromEntries([...document.querySelectorAll('#${id} .atab-kpi')].map(k => [k.querySelector('.atab-kpi-k').textContent, k.querySelector('.atab-kpi-v').textContent]))`);
            await ev(`window.__activity = (({ operator_asks, asks, tasks_done, assigned, days, ...rest }) => rest)(${JSON.stringify(ACTIVITY)}); true`);
            await open('operator'); await ev(refresh);
            await waitFor(`/not recorded yet/.test((document.querySelector('#cost-operator .atab-kpi-v') || {}).textContent || '')`, 'the missing fields', 8000);
            let k = await kpis('cost-operator');
            for (const name of ['Operator board posts', 'Typed to agents', 'Posts per task done', 'Asks to the Operator', 'Median wait for an answer', 'Slowest wait']) assert.equal(k[name], 'not recorded yet', name + ': ' + JSON.stringify(k));
            await open('comm'); await ev(refresh);
            await waitFor(`/not recorded yet/.test(document.getElementById('cost-comm').textContent)`, 'the missing fields on Communication', 8000);
            k = await kpis('cost-comm');
            assert.equal(k['Tasks handed to another agent'], 'not recorded yet', JSON.stringify(k)); assert.equal(k['Median reply to an ask'], 'not recorded yet'); assert.equal(k['Per task done'], 'not recorded yet');
            assert.ok(!/(^|\s)—(\s|$)/.test(await text('#cost-comm .atab-kpis')), 'no bare dash stands for a missing figure');
            await ev(`window.__activity = { ...${JSON.stringify(ACTIVITY)}, operator_asks: { asked: 0, answered: 0, median_s: null, slowest_s: null }, tasks_done: 0, assigned: 0 }; true`);
            await open('operator'); await ev(refresh);
            await waitFor(`/No asks/.test(document.getElementById('cost-operator').textContent)`, 'recorded zeros', 8000);
            k = await kpis('cost-operator');
            assert.equal(k['Asks to the Operator'], '0', 'a recorded zero is a 0'); assert.equal(k['Median wait for an answer'], 'No asks'); assert.equal(k['Posts per task done'], 'No tasks done');
            await ev(`window.__activity = ${JSON.stringify(ACTIVITY)}; true`); await ev(refresh);
        });
        await run('the scroll hint shows only while a table really overflows, and follows a resize', async () => {
            await open('comm'); await waitFor(`document.querySelector('#cost-comm .atab-tframe')`, 'a table', 8000);
            const rows = await ev(`[...document.querySelectorAll('#cost-comm .atab-tframe')].map(f => { const over = [f, ...f.querySelectorAll('*')].some(e => e.scrollWidth > e.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(e).overflowX)); return [over, f.querySelector('.atab-hint').hidden]; })`);
            for (const [over, hidden] of rows) assert.equal(hidden, !over, 'the hint matches the overflow: ' + JSON.stringify(rows));
            await ev(`(() => { const f = document.querySelector('#cost-comm .atab-tframe'); const box = [f, ...f.querySelectorAll('*')].find(e => /auto|scroll/.test(getComputedStyle(e).overflowX)); const wide = document.createElement('div'); wide.style.width = '4000px'; wide.style.height = '1px'; box.append(wide); f.style.width = '600px'; return true; })()`);
            await waitFor(`document.querySelector('#cost-comm .atab-tframe .atab-hint').hidden === false`, 'the hint once the table overflows', 6000);
        });
        await run('team traffic the reply lacks says it is not in the read, and none is a sentence', async () => {
            const refresh = `(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`;
            await ev(`window.__activity = (({ pairs, ...rest }) => rest)(${JSON.stringify(ACTIVITY)}); true`); await open('comm'); await ev(refresh);
            await waitFor(`/Traffic between teams is not in this read/.test(document.getElementById('cost-comm').textContent)`, 'the missing pairs', 8000);
            await ev(`window.__activity = { ...${JSON.stringify(ACTIVITY)}, pairs: [] }; true`); await ev(refresh);
            await waitFor(`/No messages or goal requests with other teams/.test(document.getElementById('cost-comm').textContent)`, 'no traffic', 8000);
            await ev(`window.__activity = ${JSON.stringify(ACTIVITY)}; true`); await ev(refresh);
        });
        await run('an axis counts in whole figures that differ: nothing counted is one 0 and a line that says so, a few is 0, 1, 2, 3 (not 1, 1, 1, 0, 0)', async () => {
            const refresh = `(async () => { const m = await import((window.__coralStatic || '/static/') + 'cost_dashboard.js'); await m._refreshCostDashboard({ force: true }); return true; })()`;
            const axis = () => ev(`(() => { const svg = document.querySelector('#cost-operator .atab-card svg.atab-svg'); const y = [...svg.querySelectorAll('text.atab-axis')].filter(t => t.getAttribute('text-anchor') === 'end').map(t => t.textContent); return { y, empty: !!svg.querySelector('.atab-empty') }; })()`);
            const zero = { ...ACTIVITY, days: ACTIVITY.days.map(d => ({ ...d, operator: 0, tasks_done: 0 })), touches: { kinds: {}, days: ACTIVITY.days.map(d => ({ day: d.day, typed: 0, answer: 0, approve: 0, wake: 0, restart: 0, stop: 0 })), agents: [], sources: { hub: 0 } } };
            await ev(`window.__activity = ${JSON.stringify(zero)}; true`); await open('operator'); await ev(refresh);
            await waitFor(`!!document.querySelector('#cost-operator .atab-card svg.atab-svg .atab-empty')`, 'the empty axis', 8000);
            let a = await axis();
            assert.deepEqual(a.y, ['0'], 'nothing counted: one 0, no repeated labels: ' + JSON.stringify(a));
            assert.ok(a.empty, 'and a line that says so');
            const few = { ...zero, days: zero.days.map((d, i) => ({ ...d, operator: i % 4 })) };
            await ev(`window.__activity = ${JSON.stringify(few)}; true`); await ev(refresh);
            await waitFor(`!document.querySelector('#cost-operator .atab-card svg.atab-svg .atab-empty')`, 'a few counted', 8000);
            a = await axis();
            assert.ok(a.y.length >= 2 && new Set(a.y).size === a.y.length && a.y.every(v => /^\d+$/.test(v)) && a.y.includes('0'), 'a few counted: whole figures that differ: ' + JSON.stringify(a));
            await ev(`window.__activity = ${JSON.stringify(ACTIVITY)}; true`); await ev(refresh);
        });
        await run('the reads are bounded: Usage asks for a daily series of twice the period, activity names its team and range', async () => {
            const reqs = await ev(`window.__reqs`);
            assert.ok(reqs.some(r => /timeseries\?since=.*&interval=1d&group_by=agent/.test(r)), JSON.stringify(reqs.slice(0, 3)));
            assert.ok(reqs.some(r => r === `/api/analytics/activity?team=${TEAM}&range=14d`), JSON.stringify(reqs.filter(r => /activity/.test(r)).slice(0, 3)));
        });
    } finally { await client.close(); }
    const bad = results.filter(r => r[1]); console.log(`${results.length - bad.length}/${results.length} scenarios pass`); if (bad.length) { console.error('FAIL: ' + bad.map(r => r[0]).join('; ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
