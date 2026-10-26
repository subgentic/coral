// The Cost tables on a phone (#5056, #7743): at 390 px the tables fold (data_table's labeled fold) and Cost, the figure the page is opened for, follows the name lines, so it is on screen without a scroll;
// everything else keeps its order after it. A wider window puts the table's columns back in their original order (also while the page is open), and the sort still works on the Cost column.
// By Provider, By Model, By Thinking Level, By Team, By Branch and By Agent, from stubbed answers.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

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
// The original column order of each table, as a wide window shows it.
const WIDE = {
    'cost-by-provider': ['Provider', 'Requests', 'Input', 'Output', 'Cache read', 'Cache write', 'Cost', 'Share'],
    'cost-by-model': ['Provider', 'Model', 'Requests', 'Input', 'Output', 'Cache read', 'Cache write', 'Cost', 'Share'],
    'cost-by-thinking': ['Provider', 'Model', 'Thinking level', 'Calls', 'Input', 'Output', 'Cache read', 'Cache write', 'Thinking', 'Cost', 'Share'],
    'cost-by-team': ['Team', 'Agents', 'Input', 'Output', 'Cache read', 'Cache write', 'Cost', 'Share'],
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // A phone is a coarse pointer: its 44 px filter buttons are what make the name columns wide (#5053), so that is the case under test.
        await Emulation.setEmulatedMedia({ features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        const l = Page.loadEventFired(); await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await l; await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url || u);
                if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 10, output_tokens: 20, cost_usd: 4 }, by_model: ${JSON.stringify(MODEL)}, by_thinking: ${JSON.stringify(THINKING)}, by_agent_type: ${JSON.stringify(PROVIDER)}, by_agent: ${JSON.stringify(AGENT)} });
                if (url.includes('/api/token-usage/by-team')) return json({ teams: ${JSON.stringify(TEAMS)} });
                if (url.includes('/api/token-usage/by-branch')) return json({ branches: ${JSON.stringify(BRANCHES)} });
                if (url.includes('/api/token-usage/')) return json({});
                return R(u, o); }; return true; })()`);
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`['cost-by-provider', 'cost-by-model', 'cost-by-thinking', 'cost-by-agent', 'cost-by-team', 'cost-by-branch'].every(id => document.querySelectorAll('#' + id + ' tbody tr').length >= 2)`, 'the six tables', 15000);

        // the page shows one view at a time (#7473) and a table that is not shown has no width to fold at: every view is shown at once here
        await ev(`(() => { const v = document.getElementById('cost-dashboard-view'); v.setAttribute('data-phone-item', ''); v.querySelectorAll('[data-cview]').forEach(e => { e.hidden = false; }); return true; })()`);
        const IDS = ['cost-by-provider', 'cost-by-model', 'cost-by-thinking', 'cost-by-agent', 'cost-by-team', 'cost-by-branch'];
        // each table's visible cells in reading order (a folded row is a column of lines: top, then left), their labels, and whether each sits inside the card
        const look = () => ev(`(() => { const out = {}; for (const id of ${JSON.stringify(IDS)}) {
            const box = document.getElementById(id), card = box.getBoundingClientRect(), dt = box.querySelector('.dt-box');
            const inside = e => { const r = e.getBoundingClientRect(); return r.left >= card.left - 1 && r.right <= card.right + 1; };
            const cells = [...box.querySelectorAll('tbody tr:first-child td')].filter(td => td.getClientRects().length).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
            const labels = cells.map(td => td.dataset.label), ci = cells.findIndex(td => td.dataset.key === 'cost_usd');
            out[id] = { folded: dt.classList.contains('dt-folded'), labels, ci, inside: cells.every(inside), heads: [...box.querySelectorAll('thead th:not(.dt-check)')].map(th => th.dataset.key ? th.querySelector('.dt-sort, .dt-head-text').firstChild.textContent.trim() : ''),
                costs: [...box.querySelectorAll('tbody tr')].map(tr => tr.querySelector('td[data-key="cost_usd"]').textContent.trim()) };
        } return out; })()`);

        console.log('1. At 390 px the tables fold and Cost follows the name lines, on screen without a scroll');
        await waitFor(`${JSON.stringify(IDS)}.every(id => document.querySelector('#' + id + ' .dt-box').classList.contains('dt-folded'))`, 'the tables fold', 6000);
        let t = await look();
        const names = { 'cost-by-provider': 1, 'cost-by-model': 2, 'cost-by-thinking': 3, 'cost-by-agent': 1, 'cost-by-team': 1, 'cost-by-branch': 1 };
        for (const [id, n] of Object.entries(names)) {
            assert.ok(t[id].folded, `${id}: the table is folded: ${JSON.stringify(t[id])}`);
            assert.equal(t[id].ci, n, `${id}: Cost comes right after its ${n} name line(s): ${JSON.stringify(t[id].labels)}`);
            assert.ok(t[id].inside, `${id}: every cell is inside the card without scrolling: ${JSON.stringify(t[id])}`);
        }
        console.log('   ✓');

        console.log('2. The Cost cells hold costs, and sorting by the Cost column works');
        for (const id of IDS) assert.ok(t[id].costs.every(x => /^\$/.test(x)), `${id}: the cells under Cost are costs: ${JSON.stringify(t[id].costs)}`);
        await ev(`(() => { const s = document.querySelector('#cost-by-thinking .dt-sortbar-select'); s.value = 'input_tokens'; s.dispatchEvent(new Event('change', { bubbles: true })); s.value = 'cost_usd'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        t = await look();
        const dollars = t['cost-by-thinking'].costs.map(x => Number(x.replace(/[$,]/g, '')));
        assert.ok(dollars.every((v, i) => i === 0 || v <= dollars[i - 1]) || dollars.every((v, i) => i === 0 || v >= dollars[i - 1]), 'the rows are in cost order after the select: ' + JSON.stringify(dollars));
        assert.equal(t['cost-by-thinking'].ci, 3, 'and Cost stays after the name lines');
        console.log('   ✓');

        console.log('3. A wider window puts the original column order back, with the page open; narrowing folds the tables again');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });
        await waitFor(`!document.querySelector('#cost-by-thinking .dt-box').classList.contains('dt-folded')`, 'the wide table', 6000);
        t = await look();
        for (const [id, heads] of Object.entries(WIDE)) assert.deepEqual(t[id].heads.map(h => h.replace(/[↕↑↓]/g, '').trim()), heads, `${id}: the wide order is back`);
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await waitFor(`document.querySelector('#cost-by-thinking .dt-box').classList.contains('dt-folded')`, 'folded again', 6000);
        console.log('   ✓');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
