// The team page's Agents table says which model each agent runs (#16671, walk 29 F5): a Model column beside Provider, from the agent's live session ("Opus 4.1"), a dash for an ended agent that has none. It sorts. 1280 px;
// at 390 px it folds like the other columns (nothing wider than the screen). The board's /status answer is stubbed; the live sessions are the page's own.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-model-${Date.now() % 100000}`;

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
            await ev(`(() => { for (const s of window.__LIVE) s.model = s.name === 'Orchestrator' ? 'claude-opus-4-1-20250805' : 'claude-sonnet-4-5-20250929'; return true; })()`);
            await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/board/${TEAM}/status') { const a = (name, sid, availability) => ({ name, subscriber_id: name, session_id: sid, agent_type: 'claude', availability, available: availability === 'available', reason: availability, tasks: [], open_tasks: 0 });
                    const agents = [a('Orchestrator', 'sid-1', 'available'), a('Backend Dev', 'sid-2', 'busy'), a('Old Timer', 'sid-gone', 'offline')];
                    return Promise.resolve(new Response(JSON.stringify({ agents, summary: { total: 3, available: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);
            await openTeam(ev, waitFor, TEAM); await settle(500);
            await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); t.click(); return true; })()`);
            await waitFor(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).length === 3`, `${at}the three agents`, { timeout: 8000 });
            const grid = await ev(`(() => ({ heads: [...document.querySelectorAll('th')].filter(h => h.getClientRects().length).map(h => h.textContent.trim().replace(/\\s+/g, ' ')),
                rows: [...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).map(r => r.innerText.replace(/\\s+/g, ' ')), wide: document.documentElement.scrollWidth > innerWidth + 1 }))()`);
            if (!mobile) {
                check(grid.heads.some(x => /^Model/.test(x)) && grid.heads.some(x => /^Provider/.test(x)), `${at}Provider and Model are both columns: ${JSON.stringify(grid.heads)}`);
                const row = n => grid.rows.find(r => r.includes(n)) || '';
                check(/Opus 4\.1/.test(row('Orchestrator')), `${at}the Orchestrator runs Opus 4.1: ${row('Orchestrator')}`);
                check(/Sonnet 4\.5/.test(row('Backend Dev')), `${at}Backend Dev runs Sonnet 4.5: ${row('Backend Dev')}`);
                check(!/Opus|Sonnet/.test(row('Old Timer')), `${at}an ended agent names no model: ${row('Old Timer')}`);
                const names = () => ev(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).map(r => (r.innerText.match(/Backend Dev|Orchestrator|Old Timer/) || [''])[0])`);
                const clickHead = () => ev(`(() => { const th = [...document.querySelectorAll('th')].filter(h => h.getClientRects().length).find(h => h.textContent.trim().startsWith('Model')); (th.querySelector('button, .dt-sort, a') || th).click(); return true; })()`);
                await clickHead(); await settle(300); const o1 = await names(); await clickHead(); await settle(300); const o2 = await names();
                check(JSON.stringify(o1) !== JSON.stringify(o2), `${at}Model sorts both ways: ${JSON.stringify([o1, o2])}`);
                // #18160 (QA5 INFO on #16671): a sort works out each agent's model once per drawing, not on every compare. Reads of a live session's model during one more click on the header
                await ev(`(async () => { const st = (await import((window.__coralStatic || '/static/') + 'state.js')).state; window.__modelReads = 0; for (const s of st.liveSessions) { const v = s.model; Object.defineProperty(s, 'model', { get() { window.__modelReads++; return v; }, configurable: true }); } return true; })()`);
                await clickHead(); await settle(300);
                const reads = await ev(`window.__modelReads`);
                check(reads <= 4, `${at}one sort reads each session's model about once, not on every compare: ${reads} reads`);
            } else {
                check(!grid.wide, `${at}nothing is wider than the screen with the column: ${JSON.stringify(grid)}`);
            }
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('team_agents_model_column_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
