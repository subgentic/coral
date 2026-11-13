// The Sub-agents tab (#16016, the Operator's request): per agent, each sub-agent it launched with what it was asked, its state and how long it ran. Nothing of it is in the page at start (the tab, its panel, its script and its sheet
// come when the agent has sub-agents), it opens the sub-agent's detail from a row, and it goes when the agent has none. 1440 and 390, light and dark. SHOT_DIR=<dir> saves a shot of each. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const FIXTURE = [
    { id: 1, subagent_id: 'sa1', session_id: 'sid', subagent_type: 'Explore', description: 'Find where the login token is refreshed', status: 'completed', finished: true, started_at: '2026-11-13T10:00:00Z', last_activity_at: '2026-11-13T10:02:05Z', api_calls: 12, cost_usd: 0.4321 },
    { id: 2, subagent_id: 'sa2', session_id: 'sid', subagent_type: 'general-purpose', description: 'Write the failing test for the refresh race <img src=x onerror=alert(1)>', status: 'in_progress', finished: false, started_at: new Date(Date.now() - 90000).toISOString(), last_activity_at: new Date().toISOString(), api_calls: 3, cost_usd: 0.05 },
    { id: 3, subagent_id: 'sa3', session_id: 'sid', subagent_type: '', description: '', status: 'skipped', finished: false, started_at: '2026-11-13T09:00:00Z', api_calls: 1, cost_usd: 0 },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [], check = (ok, what) => { if (!ok) problems.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) for (const theme of ['light', 'dark']) {
            const at = `${w} ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            const start = await ev(`({ tab: !!document.getElementById('agentic-tab-subagents'), panel: !!document.getElementById('agentic-panel-subagents'), asked: performance.getEntriesByType('resource').map(e => e.name).filter(n => /subagents_tab/.test(n)).length })`);
            check(!start.tab && !start.panel && start.asked === 0, `${at}: nothing of the tab at start ${JSON.stringify(start)}`);
            await ev(`window.__subs = ${JSON.stringify(FIXTURE)}; const real = window.fetch;
                window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (/\\/subagents$/.test(p.pathname)) return Promise.resolve(new Response(JSON.stringify(window.__subs), { status: 200, headers: { 'Content-Type': 'application/json' } })); return real(u, o); };
                window.__m.add('dev', 'S', 1, { sleeping: false, board_project: 'team-a', board_is_orchestrator: false, board_subscriber_id: 'Dev', display_name: 'Dev' });
                window.__m.add('dev2', 'S', 1, { sleeping: false, board_project: 'team-a', board_is_orchestrator: false, board_subscriber_id: 'Dev2', display_name: 'Dev Two' }); true`);
            await waitFor(`window.__qaState.liveSessions.some(s => s.name === 'dev') && window.__qaState.liveSessions.some(s => s.name === 'dev2')`, `${at}: the stand-in agents`);
            await ev(`window.selectLiveSession('dev', 'claude', 'sid', 'local'); true`);
            await ev(`(() => { const d = document.getElementById('agentic-state'); if (d.getBoundingClientRect().width < 50 || d.classList.contains('collapsed')) (document.getElementById('panel-toggle-btn') || document.getElementById('popout-panel-toggle-btn'))?.click(); return true; })()`);
            await waitFor(`!!document.getElementById('agentic-tab-subagents')`, `${at}: the tab appears`, 6000);
            await ev(`document.getElementById('agentic-tab-subagents').click(); true`);
            await waitFor(`document.getElementById('agentic-panel-subagents').classList.contains('active') && document.querySelectorAll('#agentic-panel-subagents .subagents-row').length === 3`, `${at}: the panel opens with three rows`, 6000);
            const s = await ev(`(() => { const p = document.getElementById('agentic-panel-subagents'), r = [...p.querySelectorAll('.subagents-row')].map(x => [x.querySelector('.subagents-state').textContent, x.querySelector('.subagents-title').textContent, x.querySelector('.subagents-meta').textContent].join(' | ')), b = document.getElementById('agentic-tab-subagents').getBoundingClientRect();
                return { rows: r, imgs: p.querySelectorAll('img').length, count: document.getElementById('subagents-count').textContent, label: document.getElementById('agentic-tab-subagents').getAttribute('aria-label'), tabsActive: document.querySelectorAll('#agentic-block-top .agentic-tab.active').length, mineActive: document.getElementById('agentic-tab-subagents').classList.contains('active'), tasksActive: document.getElementById('agentic-tab-tasks').classList.contains('active'),
                    overlap: (() => { const r = [...document.querySelectorAll('#agentic-block-top .agentic-state-tabs > .agentic-tab')].filter(b => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden' && !b.classList.contains('tab-more')).map(b => b.getBoundingClientRect()); return r.some((a, i) => i > 0 && a.left < r[i - 1].right - 1 && a.top === r[i - 1].top); })(), fits: p.scrollWidth <= p.clientWidth + 1, pageScroll: document.documentElement.scrollWidth > innerWidth + 1, tabShown: b.width > 0, tasksShown: document.getElementById('agentic-tab-tasks').getBoundingClientRect().width > 0, dock: getComputedStyle(document.getElementById('agentic-block-top')).display }; })()`);
            check(/^Done \| Find where the login token is refreshed \| Explore · ran 2 min · 12 calls · \$0\.43/.test(s.rows[0]), `${at}: the finished row says what, its type, how long, calls and cost: ${s.rows[0]}`);
            check(/^Running \| Write the failing test for the refresh race <img src=x onerror=alert\(1\)> \| general-purpose · ran \d+ (s|min)/.test(s.rows[1]), `${at}: the running row: ${s.rows[1]}`);
            check(/^Stopped \| Sub-agent \| 1 call$/.test(s.rows[2]), `${at}: a stopped one with no description: ${s.rows[2]}`);
            check(s.imgs === 0, `${at}: a description is text, no element`);
            check(s.count === '3' && s.label === 'Sub-agents' && s.tabsActive === 1 && s.mineActive && !s.tasksActive, `${at}: the count and the one open tab ${JSON.stringify(s)}`);
            check(mobile || !s.overlap, `${at}: no two tabs on top of each other`);
            check(s.fits && !s.pageScroll && s.tabShown, `${at}: it fits ${JSON.stringify(s)}`);
            if (process.env.SHOT_DIR) { await new Promise(r => setTimeout(r, 500)); /* sleep-ok: the tabs' colour transition (0.15 s) ends before the shot */ fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.SHOT_DIR}/subagents-${w}-${theme}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            // a row opens the detail
            await ev(`document.querySelector('#agentic-panel-subagents [data-subagent-id="sa1"]').click(); true`);
            await waitFor(`/Subagent/.test(document.getElementById('task-detail-modal-title')?.textContent || '') && getComputedStyle(document.getElementById('task-detail-modal')).display !== 'none'`, `${at}: a row opens the sub-agent's detail`, 6000);
            await ev(`window.closeTaskDetailModal?.(); document.getElementById('task-detail-modal').style.display = 'none'; true`);
            // another agent with none: the tab goes and Tasks is open
            await ev(`(() => { window.__subs = []; window.selectLiveSession('dev2', 'claude', 'sid2', 'local'); return true; })()`);
            await waitFor(`!document.getElementById('agentic-tab-subagents') && !document.getElementById('agentic-panel-subagents')`, `${at}: the tab goes with the sub-agents`, 6000);
            check(await ev(`document.getElementById('agentic-tab-tasks').classList.contains('active')`), `${at}: Tasks is the open tab again`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'The Sub-agents tab:\n  ' + problems.join('\n  '));
    console.log('PASS the Sub-agents tab');
})().catch(e => { console.error(e); process.exit(1); });
