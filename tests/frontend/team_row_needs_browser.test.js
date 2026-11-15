// A team row in the sidebar says what waits for the Operator (#17781, walk 64 #17339 item 2): a board question to the Operator (a plan to approve) puts a count on the team's row, collapsed or not, with the same number the team page's
// Needs you tab carries; a team with nothing waiting shows none; the count goes when the question is answered. The question list is a stub of /api/operator-asks; the rows are drawn from state.liveSessions at 1440.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;
const row = (id, team) => ({ session_id: id, name: id, agent_type: 'claude', working_directory: '/tmp/' + team, board_project: team, display_name: id, sleeping: false });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const chip = team => ev(`(() => { const h = document.querySelector('li.session-team-group > .session-group-header[data-group-name="${team}"]'), c = h && h.querySelector('.team-row-needs'); if (!c) return null; const r = c.getBoundingClientRect(); return { text: c.textContent.trim(), label: c.getAttribute('aria-label'), visible: r.width > 0 && r.height > 0, inList: !!c.closest('.board-card-agents') }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { localStorage.removeItem('coral-group-by-team'); localStorage.removeItem('coral_collapsed_groups'); window.switchNavTab('agents');
            const ago = m => new Date(Date.now() - m * 60000).toISOString(); window.__asks = [{ board: 'alpha', board_label: 'alpha', kind: 'ask', id: 5, asker: 'Orchestrator', text: '@Operator approve the plan?', at: ago(5) }];
            const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
        await ev(`import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`); // the page's own first read was before the stub
        await ev(`window._coralSetLiveSessions(${JSON.stringify([row('a1', 'alpha'), row('b1', 'beta')])}); true`);
        await waitFor(`document.querySelectorAll('li.session-team-group').length >= 2`, 'the team rows', 10000);
        await waitFor(`!!document.querySelector('li.session-team-group > .session-group-header[data-group-name="alpha"] .team-row-needs')`, 'the count on the team row of the question', 15000).catch(() => {});
        const a = await chip('alpha');
        if (!a || a.text.replace(/\s+/g, ' ') !== '1 needs input' || !/1 needs you/.test(a.label || '') || !a.visible || a.inList) problems.push('the question to the Operator puts "1 needs input" (label "1 needs you") on the team row: ' + JSON.stringify(a));
        if (await chip('beta')) problems.push('a team with nothing waiting shows no count');
        await ev(`localStorage.setItem('coral_collapsed_groups', JSON.stringify(['alpha'])); window._coralSetLiveSessions(${JSON.stringify([row('a1', 'alpha'), row('b1', 'beta')])}); true`);
        await waitFor(`!!document.querySelector('li.session-team-group > .session-group-header[data-group-name="alpha"] + ul.board-card-collapsed')`, 'the team folds', 8000).catch(() => {});
        const folded = await chip('alpha');
        if (!folded || !folded.visible) problems.push('a collapsed team row still shows its count: ' + JSON.stringify(folded));
        await ev(`window.__asks = []; import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
        await waitFor(`!document.querySelector('.team-row-needs')`, 'the count goes when the question is answered', 15000).catch(() => {});
        if (await chip('alpha')) problems.push('the count stays after the question is answered');
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('team_row_needs_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
