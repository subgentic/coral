// The Cost page's Export CSV (#21021, the approved stage-1 mock #21017): the control is in the page bar with the Team select (the Overview alone), opens a chooser (by task or by goal, the range said), and the file's Total row is the page's
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
        await ev(`(() => { window.__tasks = ${JSON.stringify(TASKS)}; const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url || u);
                if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 300, output_tokens: 30, cost_usd: 2.14, num_requests: 3 }, by_model: [], by_thinking: [], by_agent_type: [], by_agent: [], by_agent_name: [] });
                if (url.includes('/api/board/tasks')) return json({ tasks: window.__tasks });
                if (url.includes('/api/analytics/limit-waits')) return json({ tracking: true, totals: { waits: 0, at_reset: 0, early: 0 }, rows: [], waiting: 0, teams: ['b', 'c'] });
                if (url.includes('/api/call-metrics/summary')) return json({ rows: [] });
                if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
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

        await run('the control is in the page bar, after the range and the Team select, and opens the chooser with the range said', async () => {
            assert.deepEqual(await ev(`[...document.querySelector('.cost-header-actions').children].map(c => c.id || c.textContent.replace(/\\s+/g, ' ').trim().replace(/^refresh /, ''))`), ['cost-time-range', 'cost-team', 'Refresh', 'cost-export']);
            assert.equal(await ev(`document.getElementById('cost-export').textContent.trim()`), 'Export CSV');
            await ev(`document.getElementById('cost-export').click(); true`);
            await waitFor(`!!document.getElementById('cost-export-modal')`, 'the chooser', 5000);
            assert.match(await ev(`document.getElementById('cost-export-modal').textContent.replace(/\\s+/g, ' ')`), /Export cost as CSV ?By task ?By goal ?The range above: the last 24 hours\. Totals match this page\./);
            assert.equal(await ev(`document.querySelector('#cost-export-modal input[value="task"]').checked`), true);
            await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
            await waitFor(`!document.getElementById('cost-export-modal')`, 'Escape closes it', 5000);
        });
        await run('by task: the Total row is the page\'s Total cost and a formula title is text', async () => {
            const f = await csv('task');
            assert.match(f.name, /^coral-cost-by-task-day-\d{4}-\d{2}-\d{2}\.csv$/);
            assert.equal(f.rows.length, 1 + 4 + 1 + 1, JSON.stringify(f.rows));
            const total = f.rows[f.rows.length - 1].split(',');
            assert.equal(total[0], 'Total'); assert.equal(Number(total[7]), 2.14);
            assert.equal(await ev(`document.getElementById('cost-total-cost').textContent.trim()`), '$' + Number(total[7]).toFixed(2));
            assert.ok(f.rows.some(r => r.startsWith('"\'=HYPERLINK(""http://x"",""go"")"')), JSON.stringify(f.rows));
            assert.ok(f.rows.some(r => r.startsWith('"Second, with a comma"')));
            assert.ok(f.rows.some(r => r.startsWith('Not on a task,') && r.includes(',1.52,')), 'the cost no task carries is its own row');
        });
        await run('by goal: the rows of the By goal table and the same Total', async () => {
            const f = await csv('goal');
            assert.match(f.name, /^coral-cost-by-goal-day-/);
            const byName = Object.fromEntries(f.rows.slice(1, -1).map(r => [r.split(',')[0], r.split(',')]));
            assert.equal(Number(byName['Ship it'][3]), 0.55); assert.equal(Number(byName['Ship it'][2]), 2);
            assert.equal(Number(byName['Polish'][3]), 0.04);
            assert.ok(byName['Tasks with no goal'] && byName['Not on a task']);
            assert.equal(Number(f.rows[f.rows.length - 1].split(',')[3]), 2.14);
            await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => m.selectView('goal')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#cost-by-goal tbody tr').length === 4`, 'the goal table', 15000);
            const shown = await ev(`[...document.querySelectorAll('#cost-by-goal tbody tr')].map(tr => tr.children[0].textContent.trim()).sort()`);
            assert.deepEqual(shown, Object.keys(byName).sort(), 'the file has the rows the table draws');
            await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => m.selectView('overview')).then(() => true)`);
        });
        await run('the Team select narrows the file to that team\'s tasks, with no rest row', async () => {
            await ev(`(() => { const s = document.getElementById('cost-team'); s.value = 'b'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.getElementById('cost-team').value === 'b'`, 'team b', 5000);
            const f = await csv('task');
            assert.match(f.name, /^coral-cost-by-task-day-b-/);
            assert.equal(f.rows.length, 1 + 3 + 1, JSON.stringify(f.rows));
            assert.ok(!f.rows.some(r => /Other team task|Not on a task/.test(r)));
            assert.equal(Number(f.rows[f.rows.length - 1].split(',')[7]), 0.59);
            await ev(`document.getElementById('cost-export').click(); true`);
            await waitFor(`!!document.getElementById('cost-export-modal')`, 'the chooser', 5000);
            assert.match(await ev(`document.querySelector('.cost-export-note').textContent`), /team b: that team's tasks/);
            await ev(`[...document.querySelectorAll('#cost-export-modal button')].find(b => b.textContent === 'Cancel').click(); true`);
            await ev(`(() => { const s = document.getElementById('cost-team'); s.value = 'c'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`document.getElementById('cost-team').value === 'c'`, 'team c', 5000);
            const c = await csv('task');
            assert.equal(c.rows.length, 1 + 1 + 1, JSON.stringify(c.rows));
            await ev(`(() => { const s = document.getElementById('cost-team'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        });
        await run('the control belongs to the Overview alone, as the Team select does', async () => {
            await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => m.selectView('task')).then(() => true)`);
            await waitFor(`getComputedStyle(document.getElementById('cost-export')).display === 'none'`, 'hidden on By task', 5000);
            await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => m.selectView('overview')).then(() => true)`);
            await waitFor(`getComputedStyle(document.getElementById('cost-export')).display !== 'none'`, 'back on the Overview', 5000);
        });
        await run('a phone keeps the chooser on the screen and the page from scrolling sideways', async () => {
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.switchNavTab('tokens'); true`);
            await waitFor(`document.querySelectorAll('#cost-nav-list .row-btn').length >= 5`, 'the list of views', 10000);
            await ev(`[...document.querySelectorAll('#cost-nav-list .row-btn')].find(b => /^Overview/.test(b.textContent.trim())).click(); true`);
            await waitFor(`!!document.getElementById('cost-export') && document.getElementById('cost-export').getClientRects().length > 0`, 'the control on a phone', 10000);
            assert.ok(await ev(`document.documentElement.scrollWidth <= innerWidth`), 'no sideways scroll at 390');
            await ev(`document.getElementById('cost-export').click(); true`);
            await waitFor(`!!document.getElementById('cost-export-modal')`, 'the chooser', 5000);
            assert.ok(await ev(`(() => { const r = document.querySelector('#cost-export-modal .modal-content').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`), 'the chooser is inside the screen');
        });
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
