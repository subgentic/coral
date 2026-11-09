// The team page's Agents view has two more columns (#14861, the Operator): Open tasks (the tasks assigned to the agent that are pending, in progress or in review; a link to the Tasks tab filtered to it) and Time on task (since the claim
// of its task in progress: "1 h 12 m", a dash with none). Both sort. The board's /status answer is stubbed. 1280 px, and 390 px where they fold like the other columns (nothing wider than the screen).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-load-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM);
            await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/board/${TEAM}/status') { const ago = m => new Date(Date.now() - m * 60000).toISOString();
                    const a = (name, availability, reason, open, since, tasks) => ({ name, subscriber_id: name, agent_type: 'claude', availability, available: availability === 'available', reason, tasks: tasks || [], open_tasks: open, ...(since ? { task_since: since } : {}) });
                    const agents = [a('Backend Dev', 'busy', 'Working', 3, ago(72), [{ id: 11, scope: 'board', title: 'Fix it', status: 'in_progress' }]), a('Orchestrator', 'available', 'Idle', 0, ''), a('Frontend Dev', 'busy', 'Working', 1, ago(5), [{ id: 12, scope: 'board', title: 'Style it', status: 'in_progress' }])];
                    return Promise.resolve(new Response(JSON.stringify({ agents, summary: { total: 3, available: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);
            await openTeam(ev, waitFor, TEAM); await settle(500);
            await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); t.click(); return true; })()`);
            await waitFor(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).length === 3`, `${at}the three agents`, { timeout: 8000 });
            const grid = await ev(`(() => { const heads = [...document.querySelectorAll('th')].filter(h => h.getClientRects().length).map(h => h.textContent.trim().replace(/\\s+/g, ' ')); const rows = [...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).map(r => r.innerText.replace(/\\s+/g, ' ').trim());
                return { heads, rows, wide: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
            if (!mobile) {
                check(grid.heads.some(x => /^Open tasks/.test(x)) && grid.heads.some(x => /^Time on task/.test(x)), `${at}the two columns are there: ${JSON.stringify(grid.heads)}`);
                const row = n => grid.rows.find(r => r.includes(n)) || '';
                check(/\b3\b/.test(row('Backend Dev')) && /1 h 12 m/.test(row('Backend Dev')), `${at}Backend Dev: 3 open tasks, 1 h 12 m on its task: ${row('Backend Dev')}`);
                check(/\b1\b/.test(row('Frontend Dev')) && /5 m/.test(row('Frontend Dev')), `${at}Frontend Dev: 1 open task, 5 m: ${row('Frontend Dev')}`);
                check(/\b0\b/.test(row('Orchestrator')) && /—/.test(row('Orchestrator')), `${at}Orchestrator: 0 open tasks and a dash for time: ${row('Orchestrator')}`);
                // sortable
                await ev(`[...document.querySelectorAll('th')].filter(h => h.getClientRects().length).find(h => /^Open tasks/.test(h.textContent.trim())).querySelector('button, .dt-sort, a')?.click() || [...document.querySelectorAll('th')].find(h => /^Open tasks/.test(h.textContent.trim())).click(); true`);
                await settle(300);
                const order1 = await ev(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).map(r => (r.innerText.match(/Backend Dev|Orchestrator|Frontend Dev/) || [''])[0])`);
                await ev(`[...document.querySelectorAll('th')].filter(h => h.getClientRects().length).find(h => /^Open tasks/.test(h.textContent.trim())).querySelector('button, .dt-sort, a')?.click() || [...document.querySelectorAll('th')].find(h => /^Open tasks/.test(h.textContent.trim())).click(); true`);
                await settle(300);
                const order2 = await ev(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).map(r => (r.innerText.match(/Backend Dev|Orchestrator|Frontend Dev/) || [''])[0])`);
                check(JSON.stringify(order1) !== JSON.stringify(order2) && (order1[0] === 'Orchestrator' || order2[0] === 'Orchestrator') && (order1[2] === 'Backend Dev' || order2[2] === 'Backend Dev'), `${at}Open tasks sorts both ways: ${JSON.stringify([order1, order2])}`);
                // the number is a link to the Tasks tab filtered to the agent
                await ev(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).find(r => r.innerText.includes('Backend Dev')).querySelector('button.dt-link:not([data-chat])') && [...[...document.querySelectorAll('tr.dt-row')].find(r => r.innerText.includes('Backend Dev')).querySelectorAll('button.dt-link')].find(b => b.textContent.trim() === '3').click(); true`);
                await waitFor(`/agent=Backend(\\+|%20)Dev/.test(location.search) && /tasks/.test(location.pathname + location.search)`, `${at}the 3 opens the Tasks tab filtered to Backend Dev`, { timeout: 8000 });
            } else {
                check(!grid.wide, `${at}nothing is wider than the screen with the two new columns: ${JSON.stringify(grid)}`);
            }
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('team_agents_load_columns_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
