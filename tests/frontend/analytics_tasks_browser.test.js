// The Analytics Tasks view (#17206, the Operator's "how many tasks is each agent completing"): a line a group over the days above a table that is its legend, the period and Group by selects, the review-tasks
// switch, at 1440 px dark and 390 px light. GET /api/analytics/tasks is stubbed by the query it is given, so what is pinned is the page: Tasks listed after Usage, the read it makes, one line and one swatch a group
// with a stripe after the fourth (the tail summed into "Other"), the table's Completed, Failed, Median time and per-task columns, the total in the KPI strip, Group by and the switch each making their own read, the
// empty line, and no sideways scroll on the phone. Isolated dev server.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const sceneShots = require('./helpers/scene_shots');

const NAMES = ['Backend Dev', 'Frontend Dev', 'QA Reviewer 1', 'QA Reviewer 2', 'Data Science', 'DevOps', 'Security', 'Docs Writer', 'Orchestrator'];
const days = 14;
const today = new Date().toISOString().slice(0, 10);
const bucketsOf = () => Array.from({ length: days }, (_, i) => new Date(Date.parse(today + 'T00:00:00Z') - (days - 1 - i) * 86400000).toISOString().replace('.000Z', 'Z'));
const answer = (group, reviews) => {
    const names = group === 'agent' ? NAMES : group === 'model' ? ['claude-fable-5-1', 'claude-sonnet-5-5', 'gpt-5'] : group === 'team' ? ['coral-go-team', 'windows'] : ['claude', 'codex'];
    const groups = names.map((n, j) => { const series = Array.from({ length: days }, (_, i) => ((i + j) % 4) + (j === 0 ? 2 : 0)); const completed = series.reduce((a, b) => a + b, 0) + (reviews ? 3 : 0);
        return { key: n, label: n, completed, failed: j % 3 === 0 ? 2 : 0, median_seconds: j === 1 ? null : 600 + j * 900, tokens_per_task: j === 1 ? undefined : 120000 + j * 1000, cost_per_task: j === 1 ? undefined : 1.5 + j, series }; });
    const total = groups.reduce((a, g) => a + g.completed, 0), failed = groups.reduce((a, g) => a + g.failed, 0);
    return { range: '14d', group_by: group, include_reviews: reviews, bucket: 'day', buckets: bucketsOf(), total: { completed: total, failed }, groups };
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const shot = sceneShots(Page, 'analytics-tasks');
    const run = async (name, fn) => { try { await fn(); results.push([name, null]); console.log('   ok   ' + name); } catch (e) { results.push([name, e]); console.log('   FAIL ' + name + ': ' + (e && e.message || e)); } };
    const open = async (key) => { await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'analytics_views.js'); m.selectView(${JSON.stringify(key)}); return true; })()`); };
    const setTheme = (t) => ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(t)}); true`);
    const size = async (w) => { await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 }); await waitFor(`window.innerWidth === ${w}`, 'the window is ' + w, 4000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { window.__reqs = []; window.__empty = false; const A = ${answer.toString()}; const NAMES = ${JSON.stringify(NAMES)}, days = ${days}, today = ${JSON.stringify(today)}, bucketsOf = ${bucketsOf.toString()};
            const R = window.fetch.bind(window);
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), p = url.pathname;
                const ok = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
                if (p === '/api/analytics/tasks') { window.__reqs.push(p + url.search); const a = A(url.searchParams.get('group_by'), url.searchParams.get('reviews') === '1'); if (window.__empty) { a.groups = []; a.total = { completed: 0, failed: 0 }; } return ok(a); }
                if (p === '/api/board/projects') return ok([{ board_id: 'coral-go-team', board_label: 'coral-go-team' }]);
                return R(u, o); };
            return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.querySelectorAll('#cost-nav-list .row-btn').length >= 4`, 'the list of views', 10000);

        await run('Tasks is listed right after Usage', async () => {
            const names = await ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].map(b => b.textContent.trim())`);
            assert.equal(names.indexOf('Tasks'), names.indexOf('Usage') + 1, JSON.stringify(names));
        });

        for (const [w, theme] of [[1440, 'dark'], [390, 'light']]) {
            const at = `${w}px ${theme}`;
            await size(w); await setTheme(theme);
            await ev(`window.__reqs.length = 0; window.__empty = false; true`);
            await open('tasks'); await waitFor(`document.querySelectorAll('#cost-tasks .atab-tname').length >= 2`, 'Tasks drawn ' + at, 10000);

            await run(`${at}: the read is a 14-day, by-agent read and the total is its total`, async () => {
                const reqs = await ev(`window.__reqs`);
                assert.ok(reqs.includes('/api/analytics/tasks?range=14d&group_by=agent'), JSON.stringify(reqs));
                const want = answer('agent', false).total.completed;
                const kpi = await ev(`(document.querySelector('#cost-tasks .atab-kpi') || {}).textContent || ''`);
                assert.ok(kpi.includes(String(want)), `the first KPI says ${want}: ${kpi}`);
            });
            await run(`${at}: a line and a swatch a group, the tail summed into Other, a stripe after the fourth`, async () => {
                assert.equal(await ev(`document.querySelectorAll('#cost-tasks svg .atab-line').length`), 8, 'seven lines and Other');
                const rows = await ev(`[...document.querySelectorAll('#cost-tasks .atab-tname')].map(e => e.textContent)`);
                assert.equal(rows.length, 8, JSON.stringify(rows)); assert.equal(rows[0], 'Backend Dev'); assert.equal(rows[7], 'Other (2)');
                assert.ok(await ev(`document.querySelectorAll('#cost-tasks .atab-tname .atab-sw-stripe').length`) >= 4, 'no two lines told apart by colour alone');
                assert.ok(await ev(`document.querySelectorAll('#cost-tasks svg .atab-line[style*="dash"]').length`) >= 3, 'the later lines are dashed');
            });
            await run(`${at}: the table has Completed, Failed, Median time and the per-task figures; a task with no time says —`, async () => {
                const t = await ev(`(document.querySelector('#cost-tasks .atab-card') || {}).textContent || ''`);
                for (const h of ['Completed', 'Failed', 'Median time', 'Tokens per task', 'Cost per task']) assert.ok(t.includes(h), 'column ' + h + ': ' + t.slice(0, 200));
                assert.ok(/10 min/.test(t), 'a median in minutes: ' + t.slice(0, 300));
                assert.ok(t.includes('—'), 'a missing figure is a dash, not 0');
            });
            await run(`${at}: Group by and the review switch each make their own read`, async () => {
                await ev(`(() => { window.__reqs.length = 0; const s = [...document.querySelectorAll('#cost-tasks select')].find(x => [...x.options].some(o => o.value === 'provider')); s.value = 'model'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await waitFor(`window.__reqs.some(r => /group_by=model/.test(r))`, 'the by-model read', 8000);
                await waitFor(`[...document.querySelectorAll('#cost-tasks .atab-tname')].some(e => e.textContent === 'claude-sonnet-5-5')`, 'the models drawn', 8000);
                await ev(`(() => { window.__reqs.length = 0; document.querySelector('#cost-tasks input[type=checkbox]').click(); return true; })()`);
                await waitFor(`window.__reqs.some(r => /reviews=1/.test(r))`, 'the read with reviews', 8000);
                const before = answer('model', false).total.completed, after = answer('model', true).total.completed;
                await waitFor(`((document.querySelector('#cost-tasks .atab-kpi') || {}).textContent || '').includes(${JSON.stringify(String(after))})`, `the total moves from ${before} to ${after}`, 8000);
                await ev(`(() => { window.__reqs.length = 0; document.querySelector('#cost-tasks input[type=checkbox]').click(); return true; })()`);
                await waitFor(`window.__reqs.length > 0`, 'the read without reviews', 8000);
                await ev(`(() => { const s = [...document.querySelectorAll('#cost-tasks select')].find(x => [...x.options].some(o => o.value === 'provider')); s.value = 'agent'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                await waitFor(`[...document.querySelectorAll('#cost-tasks .atab-tname')].some(e => e.textContent === 'Backend Dev')`, 'back to agents', 8000);
            });
            await run(`${at}: no sideways scroll of the page`, async () => {
                assert.ok(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`));
            });
            await shot(`tasks-${w}-${theme}`);
        }
        await run('a period with no task says so in one line', async () => {
            await size(1440);
            await ev(`window.__empty = true; true`);
            await ev(`window.switchNavTab('tokens'); true`); await open('overview'); await open('tasks');
            await ev(`(() => { const s = [...document.querySelectorAll('#cost-tasks select')].find(x => [...x.options].some(o => o.value === '90d')); s.value = '90d'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`/No task was completed/.test(document.querySelector('#cost-tasks').textContent)`, 'the empty line', 8000);
            assert.equal(await ev(`document.querySelectorAll('#cost-tasks svg .atab-line').length`), 0);
        });
    } finally { await client.close(); }
    const bad = results.filter(r => r[1]); console.log(`${results.length - bad.length}/${results.length} scenarios pass`); if (bad.length) { console.error('FAIL: ' + bad.map(r => r[0]).join('; ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
