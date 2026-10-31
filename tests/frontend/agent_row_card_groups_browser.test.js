// The agent row's hover card in four groups (#11423, operator feedback: "a flat list of 11 rows with no hierarchy"): the state first and larger with the age beside it; the work (goal, branch, directory, files changed);
// the agent, its model and its thinking level as one row of chips; the usage (context, tokens) quiet and last; a divider between groups; every field still there. And the ⋯ button's own tooltip ("More actions") must never
// share the screen with the card: the card is closed while the pointer is on a control of the row and opens again on the row's own space. 1280 px, a desktop sidebar.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const full = { session_id: 'g1', name: 'coral-go', display_name: 'Orchestrator', agent_type: 'claude', summary: 'Hold for ESPN cancel test', status: '', model: 'claude-opus-5-5', thinking_actual: 'medium', branch: 'flipsub', repo_name: 'heap-mem/flipsub', working_directory: '/Users/x/src/flipsub', changed_file_count: 1, context_pct: 25, context_window: 1000000, token_input: 1200, token_output: 160800, token_cache_read: 67300000, token_cost_usd: 40.29, staleness_seconds: 60, server: 'local' };
    const bare = { session_id: 'g2', name: 'coral-go2', display_name: 'Worker', agent_type: 'claude', model: '', context_pct: null, server: 'local' };
    const move = (x, y) => client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
    const rowPoint = (id, sel, dx) => ev(`(() => { const row = document.querySelector('#live-sessions-list .session-group-item[data-session-id="${id}"]'); const b = (${sel ? `row.querySelector(${JSON.stringify(sel)})` : 'row'}).getBoundingClientRect(); return { x: Math.round(b.left + ${dx === undefined ? 'b.width / 2' : dx}), y: Math.round(b.top + b.height / 2) }; })()`);
    const card = () => ev(`(() => { const t = [...document.querySelectorAll('#live-sessions-list .session-tooltip')].find(e => getComputedStyle(e).display === 'block'); if (!t) return null;
        const groups = [...t.querySelectorAll('.tt-group')]; const fs = e => parseFloat(getComputedStyle(e).fontSize); const r = t.getBoundingClientRect();
        const st = t.querySelector('.tt-state'), goal = t.querySelector('.tt-goal'), usage = t.querySelector('.tt-usage dd');
        return { rect: { l: r.left, t: r.top, r: r.right, b: r.bottom }, kinds: groups.map(g => [...g.classList].find(c => c.startsWith('tt-') && c !== 'tt-group')), dts: [...t.querySelectorAll('dt')].map(d => d.textContent),
            stateSize: st ? fs(st) : 0, workSize: goal ? fs(goal) : 0, usageSize: usage ? fs(usage) : 0,
            dividers: groups.map(g => parseFloat(getComputedStyle(g).borderTopWidth)), chipTops: [...t.querySelectorAll('.tt-kind')].map(c => Math.round(c.getBoundingClientRect().top)), chips: [...t.querySelectorAll('.tt-kind')].map(c => c.textContent),
            ago: t.querySelector('.tt-head').textContent }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`(async () => { T.state.liveSessions = ${JSON.stringify([full, bare])}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        await waitFor(`document.querySelectorAll('#live-sessions-list .session-group-item').length >= 2`, 'the rows', 6000);

        // the card of an agent with everything: four groups in order, the state biggest, the usage smallest, dividers between, chips on one line
        await move(900, 700); await sleep(100); // sleep-ok: the pointer leaves first
        const p = await rowPoint('g1', null, 40); await move(p.x, p.y);
        await waitFor(`[...document.querySelectorAll('#live-sessions-list .session-tooltip')].some(e => getComputedStyle(e).display === 'block')`, 'the card opens after its delay', 4000);
        const c = await card();
        check(c && JSON.stringify(c.kinds) === JSON.stringify(['tt-head', 'tt-work', 'tt-chips', 'tt-usage']), 'four groups in order: status, work, agent, usage: ' + JSON.stringify(c && c.kinds));
        check(c && c.stateSize >= 16 && c.stateSize > c.workSize && c.workSize > c.usageSize, 'the state is the largest line and the usage the quietest: ' + JSON.stringify(c && [c.stateSize, c.workSize, c.usageSize]));
        check(c && c.dividers[0] === 0 && c.dividers.slice(1).every(w => w >= 1), 'a divider between groups and none above the first: ' + JSON.stringify(c && c.dividers));
        check(c && c.chips.join('|') === 'claude|Opus 5.5|Medium' && new Set(c.chipTops).size === 1, 'agent, model and thinking are chips on one line: ' + JSON.stringify(c && [c.chips, c.chipTops]));
        check(c && /Last action/.test(c.ago) && /1m ago|1 min/.test(c.ago), 'the age is beside the state: ' + JSON.stringify(c && c.ago));
        for (const l of ['State', 'Last action', 'Goal', 'Branch', 'Agent', 'Model', 'Thinking', 'Context', 'Directory', 'Files changed', 'Tokens']) check(c && c.dts.includes(l), `no field lost: ${l} is still there (for a screen reader at least)`);
        { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/hover-card-grouped.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }

        // the ⋯ button: its tooltip (the browser's, from its title) and the card never show together. The card is closed the moment the pointer is on the button, and stays closed while it rests there.
        const k = await rowPoint('g1', '.sidebar-kebab-btn');
        await move(k.x, k.y); await sleep(150); // sleep-ok: one pointer event is handled
        check((await card()) === null, 'the card closes when the pointer reaches the ⋯ button');
        await sleep(1100); // sleep-ok: longer than the card's own delay: it must still not open over the button's tooltip
        check((await card()) === null, 'the card does not open while the pointer rests on the ⋯ button');
        await move(p.x, p.y);
        await waitFor(`[...document.querySelectorAll('#live-sessions-list .session-tooltip')].some(e => getComputedStyle(e).display === 'block')`, 'the card opens again on the row\'s own space', 4000);

        // an agent with little to say: no empty group and no stray divider
        await move(900, 700); await sleep(100); // sleep-ok: the pointer leaves first
        const q = await rowPoint('g2', null, 40); await move(q.x, q.y);
        await waitFor(`[...document.querySelectorAll('#live-sessions-list .session-tooltip')].some(e => getComputedStyle(e).display === 'block')`, 'the bare agent card opens', 4000);
        const b = await card();
        check(b && JSON.stringify(b.kinds) === JSON.stringify(['tt-head', 'tt-work', 'tt-chips']) || b && JSON.stringify(b.kinds) === JSON.stringify(['tt-head', 'tt-chips']), 'a group with nothing in it is left out: ' + JSON.stringify(b && b.kinds));
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS the hover card is grouped, status first, and never shares the screen with the ⋯ tooltip');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
