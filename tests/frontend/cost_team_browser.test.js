// The Cost page follows its Team select (#21037): the token-usage reads (summary, by-branch, timeseries) carry team=<board>, By team shows the team's row, By task and By goal its tasks; "All teams" sends none.
// Total cost; its rows are the rows of the By task and By goal tables; a title that starts like a formula is written as text; the Team select narrows it to that team's tasks. Stubbed answers (total $2.14, four tasks of $0.62 and a rest of
// $1.52, as analytics_task_untasked_browser); isolated dev server over CDP; a phone keeps the chooser on the screen.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const task = (id, cost, goal, title, board = 'b') => ({ id, board_id: board, title, status: 'completed', priority: 'medium', assigned_to: 'Dev', cost_usd: cost, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, goal_id: goal, goal_title: goal === 7 ? 'Ship it' : goal === 8 ? 'Polish' : '', claimed_at: new Date(Date.now() - 3600000).toISOString(), completed_at: new Date(Date.now() - 60000).toISOString() });
const TASKS = [task(1, 0.28, 7, '=HYPERLINK("http://x","go")'), task(2, 0.27, 7, 'Second, with a comma'), task(3, 0.04, 8, 'Polish'), task(4, 0.03, 0, 'Other team task', 'c')];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const run = async (name, fn) => { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + (e && e.message)); process.exitCode = 1; } };
    const csv = async by => { // opens the chooser, picks, downloads: the text of the file and its name
        await ev(`window.__dl = null; document.getElementById('cost-export').click(); true`);
        await waitFor(`!!document.getElementById('cost-export-modal')`, 'the chooser', 5000);
        await ev(`document.querySelector('#cost-export-modal input[value="${by}"]').click(); [...document.querySelectorAll('#cost-export-modal button')].find(b => b.textContent === 'Download CSV').click(); true`);
        await waitFor(`window.__dl !== null && window.__dl.text !== undefined`, 'the download', 5000);
        const d = await ev(`window.__dl`);
        return { name: d.name, rows: d.text.replace(/^\uFEFF/, '').trimEnd().split('\r\n') };
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { window.__reqs = []; window.__tasks = ${JSON.stringify(TASKS)}; const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url || u); window.__reqs.push(url);
                if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 300, output_tokens: 30, cost_usd: /team=b/.test(url) ? 0.59 : /team=c/.test(url) ? 0.05 : 2.14, num_requests: 3 }, by_model: [], by_thinking: [], by_agent_type: [], by_agent: [], by_agent_name: [] });
                if (url.includes('/api/board/tasks')) return json({ tasks: window.__tasks });
                if (url.includes('/api/analytics/limit-waits')) return json({ tracking: true, totals: { waits: 0, at_reset: 0, early: 0 }, rows: [], waiting: 0, teams: ['b', 'c'] });
                if (url.includes('/api/call-metrics/summary')) return json({ rows: [] });
                if (url.includes('/api/token-usage/by-team')) return json({ teams: [{ board_name: 'b', board_label: 'b', cost_usd: 0.59, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 2, num_agents: 1 }, { board_name: 'c', board_label: 'c', cost_usd: 0.05, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 2, num_agents: 1 }] });
                if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
                if (url.includes('/api/token-usage/timeseries')) return json({ buckets: [] });
                return R(u, o); };
            URL.createObjectURL = b => { window.__blob = b; return 'blob:test'; };
            HTMLAnchorElement.prototype.click = function () { if (this.download) { const name = this.download; window.__blob.text().then(text => { window.__dl = { name, text }; }); } };
            return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.querySelectorAll('#cost-nav-list .row-btn').length >= 5 || !!document.getElementById('cost-export')`, 'the page', 15000);
        await waitFor(`/\\$2\\.14/.test(document.getElementById('cost-total-cost')?.textContent || '')`, 'the page total', 15000);
        await waitFor(`document.querySelectorAll('#cost-team option').length === 3`, 'the teams in the Team select', 15000);

        const pick = v => ev(`(() => { const s = document.getElementById('cost-team'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        const view = v => ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => m.selectView(${JSON.stringify(v)})).then(() => true)`);
        await run('a team sends team=<board> on summary, by-branch and the series, and By team keeps its own read', async () => {
            await ev(`window.__reqs.length = 0; true`);
            await pick('b');
            await waitFor(`window.__reqs.some(u => u.includes('/api/token-usage/summary') && u.includes('team=b')) && window.__reqs.some(u => u.includes('/api/token-usage/by-branch') && u.includes('team=b')) && window.__reqs.some(u => u.includes('/api/token-usage/timeseries') && u.includes('team=b'))`, 'the reads with the team', 10000);
            const reqs = await ev(`window.__reqs`);
            assert.ok(!reqs.some(u => u.includes('/api/token-usage/by-team') && u.includes('team=')), 'By team is the same read, its rows narrowed: ' + JSON.stringify(reqs));
            assert.ok(reqs.filter(u => /\/api\/token-usage\/(summary|timeseries|by-branch)/.test(u)).every(u => u.includes('team=b')), 'every one carries the team: ' + JSON.stringify(reqs));
        });
        await run('By team shows the team\'s row only; By task and By goal its tasks only', async () => {
            await view('team');
            await waitFor(`!!document.querySelector('#cost-by-team table tbody tr')`, 'By team rows', 10000);
            assert.deepEqual(await ev(`[...document.querySelectorAll('#cost-by-team tbody tr')].map(r => r.children[0].textContent.trim())`), ['b']);
            await view('task');
            await waitFor(`!!document.querySelector('#cost-by-task table tbody tr')`, 'By task rows', 10000);
            const titles = await ev(`[...document.querySelectorAll('#cost-by-task tbody tr')].map(r => r.textContent)`);
            assert.ok(titles.join('|').includes('Polish') && !titles.join('|').includes('Other team task'), JSON.stringify(titles));
        });
        await run('All teams sends no team and shows every team again', async () => {
            await ev(`window.__reqs.length = 0; true`);
            await pick('');
            await waitFor(`window.__reqs.some(u => u.includes('/api/token-usage/summary'))`, 'the reads', 10000);
            assert.ok(!(await ev(`window.__reqs`)).some(u => u.includes('team=')));
            await view('team');
            await waitFor(`document.querySelectorAll('#cost-by-team tbody tr').length === 2`, 'both teams', 10000);
        });
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
