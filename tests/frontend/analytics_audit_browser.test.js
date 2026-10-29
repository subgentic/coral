// Analytics audit fixes (#7719, QA's #7714): Requests is one figure everywhere (the calls recorded, what By agent sums) so the tile and the tables add up; the Tool and API calls view asks for the range the select says
// (and says when the server keeps less), leaves the dashboard's own agent-less routes out even beside real calls, and on a phone lists Calls, Errors, Avg ms right after the operation; By agent puts Cost second at 1280 px
// (its sort column was cut off at the edge); the Model column is the size of its neighbours. From stubbed answers; the calls requests are recorded.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

const AGENT = [
    { session_id: 'a1', agent_name: 'Frontend Dev', board_name: 'coral-go-team', folder: 'coral', requests: 700, input_tokens: 5000, output_tokens: 700, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 3.2, first_seen: '2026-10-19T00:00:00Z', last_seen: '2026-10-19T05:00:00Z' },
    { session_id: 'a2', agent_name: 'QA Engineer', board_name: 'coral-go-team', folder: 'coral', requests: 352, input_tokens: 900, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.6, first_seen: '2026-10-19T00:00:00Z', last_seen: '2026-10-19T05:00:00Z' }];
const TYPES = [{ agent_type: 'claude', num_sessions: 2, num_requests: 900, input_tokens: 5000, output_tokens: 700, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 3.0 },
    { agent_type: 'codex', num_sessions: 1, num_requests: 152, input_tokens: 900, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.8 }];
const MODELS = [{ model: 'claude-opus-5-5', agent_type: 'claude', num_sessions: 2, num_requests: 900, input_tokens: 5000, output_tokens: 700, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 3.0 },
    { model: 'gpt-5-codex', agent_type: 'codex', num_sessions: 1, num_requests: 152, input_tokens: 900, output_tokens: 90, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.8 }];
const CALLS = [{ operation: '/api/board/{project}/messages', call_type: 'api', agent_name: '', board_name: '', calls: 49, errors: 0, avg_duration_ms: 3 },
    { operation: 'Bash', call_type: 'tool', agent_name: 'Frontend Dev', board_name: 'coral-go-team', calls: 30, errors: 2, avg_duration_ms: 120 },
    { operation: '/api/board/{project}/tasks', call_type: 'api', agent_name: 'QA Engineer', board_name: 'coral-go-team', calls: 7, errors: 0, avg_duration_ms: 9 }];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const stub = () => ev(`(() => { const R = window.fetch; window.__calls = []; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o) => { const url = String(u && u.url || u);
            if (url.includes('/api/call-metrics/summary')) { window.__calls.push(url); const h = +(new URL(url, location.origin).searchParams.get('hours')); return json({ hours: Math.min(h, 336), rows: window.__rows || ${JSON.stringify(CALLS)}, cap_dropped: 0 }); }
            if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 10, output_tokens: 20, cost_usd: 4, num_sessions: 3, num_requests: 1052 }, by_model: ${JSON.stringify(MODELS)}, by_thinking: [], by_agent_type: ${JSON.stringify(TYPES)}, by_agent: ${JSON.stringify(AGENT)} });
            if (url.includes('/api/token-usage/by-team')) return json({ teams: [] });
            if (url.includes('/api/token-usage/by-branch')) return json({ branches: [] });
            if (url.includes('/api/token-usage/')) return json({});
            return R(u, o); }; return true; })()`);
    const open = async (w, h, mobile) => {
        await Emulation.setEmulatedMedia({ features: mobile ? [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] : [{ name: 'pointer', value: 'fine' }, { name: 'hover', value: 'hover' }] });
        await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
        const l = Page.loadEventFired(); await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await l; await install();
        await coralReady(ev);
        await stub();
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`['cost-by-provider', 'cost-by-model', 'cost-by-agent'].every(id => document.querySelectorAll('#' + id + ' tbody tr').length >= 2) && document.querySelectorAll('#call-metrics-summary tbody tr').length >= 1`, 'the tables');
    };
    const heads = id => ev(`[...document.querySelectorAll('#${id} thead th:not(.dt-check)')].map(th => th.textContent.replace(/[▲▼↑↓↕]|filter_list/g, '').trim())`);
    const column = (id, name) => ev(`(() => { const t = document.getElementById('${id}'); const i = [...t.querySelectorAll('thead th:not(.dt-check)')].findIndex(th => th.textContent.replace(/[▲▼↑↓↕]|filter_list/g, '').trim() === ${JSON.stringify(name)}); return [...t.querySelectorAll('tbody tr')].map(tr => tr.querySelectorAll('td:not(.dt-check)')[i].textContent.trim()); })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await open(1280, 800, false);

        console.log('1. Requests is one figure: the tile and the tables add up');
        const sum = a => a.reduce((n, x) => n + Number(x), 0);
        const tile = await ev(`document.getElementById('cost-total-requests').textContent`);
        assert.equal(tile, '1052', 'the Overview tile is the calls recorded');
        assert.equal(sum(await column('cost-by-provider', 'Requests')), 1052, 'By provider adds up to the tile');
        assert.equal(sum(await column('cost-by-model', 'Requests')), 1052, 'By model adds up to the tile');
        assert.equal(sum(await column('cost-by-agent', 'Requests')), 1052, 'By agent adds up to the tile');
        console.log('   ✓');

        console.log('4. The calls view asks for the range the select says, and says when the server keeps less');
        const range = async v => { await ev(`(() => { const s = document.getElementById('cost-time-range'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); };
        const asked = () => ev(`window.__calls.map(u => +new URL(u, location.origin).searchParams.get('hours')).pop()`);
        await range('week'); await waitFor(`window.__calls.length > 0 && +new URL(window.__calls[window.__calls.length - 1], location.origin).searchParams.get('hours') === 168`, 'the 7 days ask');
        assert.equal(await asked(), 168, 'Last 7 days asks for 168 hours');
        await range('hour'); await waitFor(`+new URL(window.__calls[window.__calls.length - 1], location.origin).searchParams.get('hours') === 1`, 'the hour ask');
        await range('month'); await waitFor(`+new URL(window.__calls[window.__calls.length - 1], location.origin).searchParams.get('hours') === 720 && /kept for 14 days/.test(document.getElementById('call-metrics-summary').textContent)`, 'the 30 days ask and the note');
        assert.match(await ev(`document.getElementById('call-metrics-summary').textContent`), /Calls are kept for 14 days, so this shows the last 14 days\./, 'a range longer than the server keeps says what is shown');
        await ev(`window.__rows = []; true`); await range('week');
        await waitFor(`/No tool calls in the last 7 days yet/.test(document.getElementById('call-metrics-summary').textContent)`, 'the empty state names the range');
        await ev(`delete window.__rows; true`); await range('day');
        await waitFor(`document.querySelectorAll('#call-metrics-summary tbody tr').length > 0`, 'the table again');
        console.log('   ✓');

        console.log('5. The dashboard\'s own agent-less routes are left out, beside real calls too, and do not come back with a refresh');
        for (let i = 0; i < 2; i++) { await ev(`document.querySelector('[data-on-click="cost-refresh"]').click(); true`); await waitFor(`document.querySelectorAll('#call-metrics-summary tbody tr').length === 2`, 'two rows after a refresh'); }
        assert.deepEqual(await column('call-metrics-summary', 'Operation'), ['Bash', '/api/board/{project}/tasks'], 'a tool call and a route an agent called; not the agent-less route');
        console.log('   ✓');

        console.log('7. By agent: Cost is the second column at 1280 px and inside its card');
        const ah = await heads('cost-by-agent');
        assert.deepEqual(ah.slice(0, 3), ['Agent', 'Cost', 'Team'], 'Cost follows the name: ' + JSON.stringify(ah));
        assert.ok(await ev(`(() => { const box = document.getElementById('cost-by-agent'), c = box.getBoundingClientRect(), th = box.querySelectorAll('thead th:not(.dt-check)')[1].getBoundingClientRect(); return th.left >= c.left - 1 && th.right <= c.right + 1; })()`), 'the Cost heading is inside the card without a scroll');
        assert.ok((await column('cost-by-agent', 'Cost')).every(x => /^\$/.test(x)), 'and the cells under it are costs');
        console.log('   ✓');

        console.log('8. The Model column is in its neighbours font');
        const sizes = await ev(`(() => { const out = {}; for (const id of ['cost-by-model']) { const tr = document.querySelector('#' + id + ' tbody tr'); out[id] = [...tr.querySelectorAll('td:not(.dt-check)')].map(td => getComputedStyle(td).fontFamily); } return out; })()`);
        assert.equal(new Set(sizes['cost-by-model']).size, 1, 'every cell of a By model row has one font (the model is not in the code font): ' + JSON.stringify(sizes));
        console.log('   ✓');

        console.log('6. On a phone the calls table is one line a row: the operation and Calls (#8982); the wide order is back with a wider window');
        await open(390, 844, true);
        await ev(`import((window.__coralStatic || '/static/') + 'analytics_views.js').then(m => { m.selectView('calls'); return true; })`);
        await waitFor(`document.querySelectorAll('#call-metrics-summary tbody tr').length > 0 && document.querySelector('#call-metrics-summary').getClientRects().length > 0`, 'the calls view');
        const order = await ev(`[...document.querySelectorAll('#call-metrics-summary tbody tr:first-child td')].filter(td => td.getClientRects().length).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map(td => td.dataset.label || td.dataset.key)`);
        assert.deepEqual(order.map(x => String(x).toLowerCase()), ['operation', 'calls'], 'phone: one line, the operation and its Calls');
        assert.deepEqual(await ev(`[...document.querySelectorAll('#call-metrics-summary td[data-key="calls"]')].map(td => td.textContent.trim())`), ['30', '7'], 'the cells hold their column\'s figures');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await waitFor(`[...document.querySelectorAll('#call-metrics-summary thead th')].map(th => th.dataset.key).join() === 'operation,call_type,agent,team,calls,errors,avg_ms'`, 'the wide order back');
        console.log('   ✓');
        console.log('PASS Analytics audit: Requests add up, the calls view honours the range and drops dashboard routes, Cost second in By agent, calls columns on a phone, one Model size');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
