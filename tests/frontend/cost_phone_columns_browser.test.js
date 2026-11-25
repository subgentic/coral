// The Cost tables on a phone (#5056, #7743, #8982): at 390 px the tables are one line a row (the shared one-line table): the name column the table is about and Cost, the figure the page is opened for, on screen without a scroll;
// the other columns drop. A wider window puts the table's columns back in their original order (also while the page is open), and the sort still works on the Cost column.
// By Provider, By Model, By Thinking Level, By Team, By Branch and By Agent, from stubbed answers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const shotDir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out')) || path.join(require('node:os').tmpdir(), 'coral-cdp-shots');

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
const SERIES = [{ bucket: '2026-10-18T00:00:00Z', series: [{ key: 'coral-go-team', label: 'coral-go-team', cost_usd: 5.0, num_requests: 10 }, { key: 'docs-sprint', label: 'docs-sprint', cost_usd: 1.0, num_requests: 3 }] },
    { bucket: '2026-10-19T00:00:00Z', series: [{ key: 'coral-go-team', label: 'coral-go-team', cost_usd: 3.5, num_requests: 8 }, { key: 'docs-sprint', label: 'docs-sprint', cost_usd: 0.9, num_requests: 2 }] }];
// The original column order of each table, as a wide window shows it.
const WIDE = {
    'cost-by-provider': ['Provider', 'Requests', 'New input tokens', 'Output', 'Cache read', 'Cache write', 'Cost', 'Share'],
    'cost-by-model': ['Provider', 'Model', 'Requests', 'New input tokens', 'Output', 'Cache read', 'Cache write', 'Cost', 'Share'],
    'cost-by-thinking': ['Provider', 'Model', 'Thinking level', 'Calls', 'New input tokens', 'Output', 'Cache read', 'Cache write', 'Thinking', 'Cost', 'Share'],
    'cost-by-team': ['Team', 'Agents', 'New input tokens', 'Output', 'Cache read', 'Cache write', 'Cost', 'Share'],
};

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { fs.mkdirSync(shotDir, { recursive: true }); fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // A phone is a coarse pointer: its 44 px filter buttons are what make the name columns wide (#5053), so that is the case under test.
        await Emulation.setEmulatedMedia({ features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        const l = Page.loadEventFired(); await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await l; await install();
        await coralReady(ev);
        await ev(`(() => { const R = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url || u);
                if (url.includes('/api/token-usage/summary')) return json({ totals: { input_tokens: 10, output_tokens: 20, cost_usd: 4 }, by_model: ${JSON.stringify(MODEL)}, by_thinking: ${JSON.stringify(THINKING)}, by_agent_type: ${JSON.stringify(PROVIDER)}, by_agent: ${JSON.stringify(AGENT)} });
                if (url.includes('/api/token-usage/by-team')) return json({ teams: ${JSON.stringify(TEAMS)} });
                if (url.includes('/api/token-usage/by-branch')) return json({ branches: ${JSON.stringify(BRANCHES)} });
                if (url.includes('/api/token-usage/timeseries')) return json({ buckets: ${JSON.stringify(SERIES)} });
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
            out[id] = { folded: dt.classList.contains('dt-folded'), labels, ci, inside: cells.every(inside), allHeads: [...box.querySelectorAll('thead th:not(.dt-check)')].map(th => th.dataset.key ? th.querySelector('.dt-sort, .dt-head-text').firstChild.textContent.trim() : ''), heads: [...box.querySelectorAll('thead th:not(.dt-check)')].filter(th => th.getClientRects().length).map(th => th.dataset.key ? th.querySelector('.dt-sort, .dt-head-text').firstChild.textContent.trim() : ''),
                costs: [...box.querySelectorAll('tbody tr')].map(tr => tr.querySelector('td[data-key="cost_usd"]').textContent.trim()) };
        } return out; })()`);

        console.log('1. At 390 px the tables are one line a row: the name and Cost (#8982), on screen without a scroll');
        await waitFor(`${JSON.stringify(IDS)}.every(id => document.querySelector('#' + id + ' .dt-box').classList.contains('dt-one-line'))`, 'the tables are one line a row', 6000);
        let t = await look();
        const LEAD = { 'cost-by-provider': 'Provider', 'cost-by-model': 'Model', 'cost-by-thinking': 'Thinking level', 'cost-by-agent': 'Agent', 'cost-by-team': 'Team', 'cost-by-branch': 'Branch' };
        for (const id of IDS) {
            assert.ok(!t[id].folded, `${id}: not folded: ${JSON.stringify(t[id])}`);
            assert.ok(/^cost/i.test(t[id].heads.filter(Boolean).find(h => /^cost/i.test(h)) || ''), `${id}: Cost stays: ${JSON.stringify(t[id].heads)}`);
            assert.ok(t[id].heads.filter(Boolean)[0].replace(/[\u2191\u2193\u2195]/g, '').trim().startsWith(LEAD[id]), `${id}: the first column is the table's own (${LEAD[id]}): ${JSON.stringify(t[id].heads)}`);
            assert.ok(t[id].inside, `${id}: every cell is inside the card without scrolling: ${JSON.stringify(t[id])}`);
        }
        await shot('cost-phone-390');
        console.log('   ✓');

        console.log('2. The Cost cells hold costs, and a click on the Cost header sorts by it');
        for (const id of IDS) assert.ok(t[id].costs.every(x => /^\$/.test(x)), `${id}: the cells under Cost are costs: ${JSON.stringify(t[id].costs)}`);
        const before = t['cost-by-thinking'].costs.slice();
        await ev(`(() => { const th = document.querySelector('#cost-by-thinking th[data-key="cost_usd"]'); (th.querySelector('.dt-sort') || th).click(); return true; })()`);
        t = await look();
        const dollars = t['cost-by-thinking'].costs.map(x => Number(x.replace(/[$,]/g, '')));
        assert.ok(dollars.every((v, i) => i === 0 || v >= dollars[i - 1]) || dollars.every((v, i) => i === 0 || v <= dollars[i - 1]), 'the rows are in cost order: ' + JSON.stringify(dollars));
        assert.notDeepEqual(t['cost-by-thinking'].costs, before, 'and the click reversed the order');
        console.log('   ✓');

        console.log('3. A wider window puts the original column order back, with the page open; narrowing makes the tables one line again');
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });
        await waitFor(`!document.querySelector('#cost-by-thinking .dt-box').classList.contains('dt-one-line')`, 'the wide table', 6000);
        t = await look();
        for (const [id, heads] of Object.entries(WIDE)) assert.deepEqual(t[id].allHeads.map(h => h.replace(/[↕↑↓]/g, '').trim()), heads, `${id}: the wide order is back`);
        await shot('cost-wide-1280');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await waitFor(`document.querySelector('#cost-by-thinking .dt-box').classList.contains('dt-one-line')`, 'one line again', 6000);
        console.log('   ✓');

        // 4. #17734: the sticky .cost-header stays at the top after scrolling at 390 px, and the legend buttons are vertically centred (#17734 legend gap fix)
        console.log('4. Sticky header and legend gap fix at 390 px');
        // show every section (the default overview tab) so the page is tall enough to scroll, with the series chart's legend
        await ev(`(() => { const v = document.getElementById('cost-dashboard-view'); v.setAttribute('data-phone-item', ''); v.querySelectorAll('[data-cview]').forEach(e => { e.hidden = false; }); return true; })()`);
        await waitFor(`!!document.querySelector('.viz-legend-btn')`, 'the overview legend to render', 8000);
        await shot('cost-390-before-scroll');
        // scroll the cost-dashboard-view container (overflow-y: auto) past the header
        const spacing = await ev(`(() => { const l = document.querySelector('#cost-dashboard-view .cost-header-left').getBoundingClientRect(), a = document.querySelector('#cost-dashboard-view .cost-header-actions'), ar = a.getBoundingClientRect(); let next = a.closest('.cost-header').nextElementSibling; while (next && !next.getClientRects().length) next = next.nextElementSibling; return { gapAbove: Math.round(ar.top - l.bottom), gapBelow: next ? Math.round(next.getBoundingClientRect().top - ar.bottom) : null }; })()`); // #21231: the unscrolled layout is the parent's: 8 px under the bar, 20 px before the first section
        if (!(spacing.gapAbove === 8 && spacing.gapBelow >= 20)) console.error('SPACING ' + JSON.stringify(spacing));
        await ev(`document.getElementById('cost-dashboard-view').scrollBy(0, 400); true`);
        await waitFor(`document.getElementById('cost-dashboard-view').scrollTop > 100`, 'the scroll to settle', 3000);
        const headerRect = await ev(`(() => { const v = document.getElementById('cost-dashboard-view'); const h = v.querySelector('.cost-header-left'); if (!h) return null; const vr = v.getBoundingClientRect(); const hr = h.getBoundingClientRect(); const s = getComputedStyle(h), a = v.querySelector('.cost-header-actions').getBoundingClientRect(); return { offset: Math.round(hr.top - vr.top), pos: s.position, h: Math.round(hr.height), controlsBottom: Math.round(a.bottom - vr.top) }; })()`); // #21231: the bar stays (way back, title, question); the controls under it scroll away, they are not a 250 px sticky block over the cards
        await shot('cost-390-after-scroll-sticky');
        // legend gap: viz-legend-btn must be inline-flex with centered items
        const legendStyle = await ev(`(() => { const b = document.querySelector('.viz-legend-btn'); if (!b) return null; const s = getComputedStyle(b); return { display: s.display, alignItems: s.alignItems }; })()`);
        const errs = [];
        if (!(spacing.gapAbove === 8 && spacing.gapBelow >= 20)) errs.push('the controls keep their 8 px under the bar and 20 px before the sections, as before the sticky bar change: ' + JSON.stringify(spacing));
        if (!(headerRect && headerRect.offset <= 5 && headerRect.pos === 'sticky')) errs.push('the .cost-header-left (the bar) is sticky at the top of its scroll container after scrolling: ' + JSON.stringify(headerRect));
        if (!(headerRect && headerRect.h <= 110 && headerRect.controlsBottom <= headerRect.h)) errs.push('only the bar stands over the cards after scrolling (at most 110 px), the range, team and export controls scrolled away (#21231): ' + JSON.stringify(headerRect));
        if (!legendStyle) errs.push('the legend button does not exist in the overview');
        else if (!(legendStyle.display === 'inline-flex' && legendStyle.alignItems === 'center')) errs.push('the legend button is not inline-flex and centred: ' + JSON.stringify(legendStyle));
        assert.equal(errs.length, 0, errs.join('; '));
        await shot('cost-390-legend');
        // scroll back
        await ev(`document.getElementById('cost-dashboard-view').scrollTo(0, 0); true`);
        console.log('   ✓');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
