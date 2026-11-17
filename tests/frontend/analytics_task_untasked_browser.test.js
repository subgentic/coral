// The By task view adds up to the page's Total cost (walk 80): the cost no task carries is a row of its own ("Not on a task"), Cost is the second column so a tablet keeps it, and Group by has Goal (tasks added up per goal,
// the same rest row). Stubbed answers (total $2.14, four tasks adding to $0.62); tablet width; isolated dev server over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const task = (id, cost, goal, title, ago) => ({ id, board_id: 'b', title: `Task ${id}`, status: 'completed', priority: 'medium', assigned_to: 'Dev', cost_usd: cost, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, goal_id: goal || undefined, goal_title: title, completed_at: ago || new Date(Date.now() - 600000).toISOString() });
const old = new Date(Date.now() - 30 * 86400000).toISOString(); // finished a month ago: outside the day the page opens on, so its $5 is in neither the total nor a row
const TASKS = [task(1, 0.28, 7, 'Ship it'), task(2, 0.27, 7, 'Ship it'), task(3, 0.04, 8, 'Polish'), task(4, 0.03, 0), task(5, 5, 7, 'Ship it', old)];
const MANY = Array.from({ length: 100 }, (_, i) => task(100 + i, 0.001, 0)); // a full list: some tasks may be missing from it

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const cells = sel => ev(`(() => { const t = document.querySelector('${sel} table'); const h = [...t.querySelectorAll('thead th')].map(x => x.textContent.trim()); return { head: h, rows: [...t.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(c => c.textContent.trim())) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 820, height: 1180, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.__tasks = ${JSON.stringify(TASKS)}; true`);
        await ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url || u);
                if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 300, output_tokens: 30, cost_usd: window.__total === undefined ? 2.14 : window.__total, num_requests: 3 }, by_model: [], by_thinking: [], by_agent_type: [], by_agent: [] });
                if (url.includes('/api/board/tasks')) return json({ tasks: window.__tasks });
                if (url.includes('/api/call-metrics/summary')) return json({ rows: [] });
                if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
                if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
                if (url.includes('/api/token-usage/timeseries')) return json({ buckets: [] });
                return R(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => m.selectView('task')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#cost-by-task tbody tr').length === 5`, 'four tasks and the rest row (the task outside the range is not a row)', 15000);
        const t = await cells('#cost-by-task');
        const ci = t.head.findIndex(h => /^Cost/.test(h));
        assert.ok(ci >= 0, `Cost is shown on a tablet: ${JSON.stringify(t.head)}`);
        const sum = t.rows.reduce((n, r) => n + Number(r[ci].replace('$', '')), 0);
        assert.ok(Math.abs(sum - 2.14) < 0.011, `the rows add up to the total: ${sum} ${JSON.stringify(t.rows)}`);
        const rest = t.rows.find(r => r[0] === 'Not on a task');
        assert.ok(rest && rest[ci] === '$1.52', `the rest is its own row: ${JSON.stringify(t.rows)}`);
        const groups = await ev(`[...document.querySelectorAll('#cost-group-bar .eff-seg-btn')].map(b => b.textContent)`);
        assert.ok(groups.includes('Goal'), `Group by has Goal: ${JSON.stringify(groups)}`);
        await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => m.selectView('goal')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#cost-by-goal tbody tr').length === 4`, 'two goals, no goal, the rest', 15000);
        const g = await cells('#cost-by-goal');
        const names = g.rows.map(r => r[0]).sort();
        assert.deepEqual(names, ['Not on a task', 'Polish', 'Ship it', 'Tasks with no goal'], JSON.stringify(g.rows));
        const gi = g.head.findIndex(h => /^Cost/.test(h));
        assert.equal(g.rows.find(r => r[0] === 'Ship it')[gi], '$0.55');
        // 100 rows without a next cursor are complete: the rest remains unassigned spend
        await ev(`window.__tasks = ${JSON.stringify(MANY)}; import((window.__coralStatic || '/static/') + 'cost_dashboard.js').then(m => m._refreshCostDashboard({ force: true })).then(() => true)`);
        await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => m.selectView('task')).then(() => true)`);
        await waitFor(`[...document.querySelectorAll('#cost-by-task tbody tr')].some(r => r.textContent.includes('Not on a task'))`, 'a completed list names the rest Not on a task', 15000);
        assert.ok(![...await ev(`[...document.querySelectorAll('#cost-by-task tbody tr')].map(r => r.textContent)`)].some(x => x.includes('Other cost in this range')), 'no inferred truncation from row count');
        // a task that began before the range counts in full, so the tasks can add up to MORE than the Total: a negative row keeps the rows adding up instead of hiding the rest (#17827)
        await ev(`window.__total = 0.5; window.__tasks = ${JSON.stringify(TASKS)}; import((window.__coralStatic || '/static/') + 'cost_dashboard.js').then(m => m._refreshCostDashboard({ force: true })).then(() => true)`);
        await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => m.selectView('task')).then(() => true)`);
        await waitFor(`[...document.querySelectorAll('#cost-by-task tbody tr')].some(r => r.textContent.includes('Earlier spend'))`, 'tasks over the total get an "Earlier spend" row', 15000);
        const over = await cells('#cost-by-task');
        const oi = over.head.findIndex(h => /^Cost/.test(h));
        const orow = over.rows.find(r => r[0].startsWith('Earlier spend'));
        assert.ok(orow && orow[oi] === '-$0.12', `a negative row of -$0.12: ${JSON.stringify(over.rows)}`);
        const osum = over.rows.reduce((n, r) => n + Number(r[oi].replace('$', '')), 0);
        assert.ok(Math.abs(osum - 0.5) < 0.011, `with it the rows add up to the total: ${osum} ${JSON.stringify(over.rows)}`);
        console.log('PASS by task and by goal add up');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
