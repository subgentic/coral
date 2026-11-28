// A team says what waits for the Operator (#17781, walk 64 #17339 item 2): a board question to the Operator (a plan to approve) puts a Needs you item, with its count, in the team's menu (#22105, the
// approved sidebar mock: it was a chip on the team line), the same number the team page's Needs you tab carries, collapsed or not; the asking agent's mark is amber; both go when the question is answered. Stubbed /api/operator-asks, 1440.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;
const row = (id, team) => ({ session_id: id, name: id, agent_type: 'claude', working_directory: '/tmp/' + team, board_project: team, display_name: id, sleeping: false });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const chip = team => ev(`(() => { const h = document.querySelector('li.session-team-group > .session-group-header[data-group-name="${team}"]'), c = h && h.querySelector('.team-needs-item'); if (!c) return null; return { text: c.textContent.replace(/\\s+/g, ' ').trim(), action: c.dataset.onClick, inMenu: !!c.closest('.sidebar-kebab-menu'), onLine: !!h.querySelector('.team-row-needs') }; })()`);
    const mark = id => ev(`document.querySelector('#live-sessions-list .session-group-item[data-session-id="${id}"] .session-dot')?.getAttribute('aria-label')`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { localStorage.removeItem('coral-group-by-team'); localStorage.removeItem('coral_collapsed_groups'); window.switchNavTab('agents');
            const ago = m => new Date(Date.now() - m * 60000).toISOString(); window.__asks = [{ board: 'alpha', board_label: 'alpha', kind: 'ask', id: 5, asker: 'Orchestrator', text: '@Operator approve the plan?', at: ago(5) }];
            const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
        await ev(`import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`); // the page's own first read was before the stub
        await ev(`window._coralSetLiveSessions(${JSON.stringify([row('Orchestrator', 'alpha'), row('a1', 'alpha'), row('b1', 'beta')])}); true`);
        await waitFor(`document.querySelectorAll('li.session-team-group').length >= 2`, 'the team rows', 10000);
        await waitFor(`!!document.querySelector('li.session-team-group > .session-group-header[data-group-name="alpha"] .team-needs-item')`, 'the Needs you item in the team menu', 15000).catch(() => {});
        const a = await chip('alpha');
        if (!a || a.text !== 'Needs you 1' || a.action !== 'team-needs-open' || !a.inMenu || a.onLine) problems.push('the question to the Operator puts "Needs you 1" in the team menu, nothing on the team line: ' + JSON.stringify(a));
        if (await mark('Orchestrator') !== 'Needs you') problems.push('the asking agent has the amber Needs you mark: ' + await mark('Orchestrator'));
        if (await mark('a1') === 'Needs you') problems.push('an agent that asks nothing is not amber');
        if (await chip('beta')) problems.push('a team with nothing waiting shows no count');
        await ev(`localStorage.setItem('coral_collapsed_groups', JSON.stringify(['alpha'])); window._coralSetLiveSessions(${JSON.stringify([row('Orchestrator', 'alpha'), row('a1', 'alpha'), row('b1', 'beta')])}); true`);
        await waitFor(`!!document.querySelector('li.session-team-group > .session-group-header[data-group-name="alpha"] + ul.board-card-collapsed')`, 'the team folds', 8000).catch(() => {});
        const folded = await chip('alpha');
        if (!folded || folded.text !== 'Needs you 1') problems.push('a collapsed team still has the item: ' + JSON.stringify(folded));
        await ev(`window.__asks = []; import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
        await waitFor(`!document.querySelector('.team-needs-item')`, 'the item goes when the question is answered', 15000).catch(() => {});
        if (await chip('alpha')) problems.push('the item stays after the question is answered');
        if (await mark('Orchestrator') === 'Needs you') problems.push('the mark is not amber once the question is answered');
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('team_row_needs_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
