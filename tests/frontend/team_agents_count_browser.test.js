// The team's Agents tab and the sidebar's group agree on how many agents the team has (#10164, Beta Tester #10140: archived, tab 3 against sidebar 2): the sidebar lists a team's live agents and puts an archived one in its own section, so
// the tab's number is the same live agents, and the archived one is still found under the Archived chip (the table keeps it). The board's /status answer is stubbed with a free, a sleeping and an archived agent. 1280 px, through the real team page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-count-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM);
        await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/board/${TEAM}/status') { const a = (name, availability, reason) => ({ name, subscriber_id: name, agent_type: 'claude', availability, available: availability === 'available', reason, tasks: [] });
                const agents = [a('Orchestrator', 'available', 'Idle'), a('Backend Dev', 'sleeping', 'Agent is sleeping'), a('Shelved', 'archived', 'Agent is archived; unarchive it before assigning work')];
                return Promise.resolve(new Response(JSON.stringify({ agents, summary: { total: 3, available: 1, sleeping: 1, archived: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM); await settle(500);
        await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); t.click(); return true; })()`);
        await waitFor(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).length === 2`, 'the two live agents in the table', { timeout: 8000 });
        const r = await ev(`(() => { const tab = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); const g = [...document.querySelectorAll('.session-group-count')].find(e => e.closest('.session-board-card, .session-team-group')); return { tab: (tab.querySelector('.team-tab-count') || {}).textContent || '', group: g ? g.textContent.trim() : null, chips: [...document.querySelectorAll('.goals-chip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim()) }; })()`);
        assert.equal(r.group, '2', 'the sidebar group lists the two live agents: ' + JSON.stringify(r));
        assert.equal(r.tab, r.group, 'the tab says the same number as the sidebar group: ' + JSON.stringify(r));
        assert.ok(r.chips.some(c => /^Archived\s*1/.test(c)), 'the archived agent is still found under its chip: ' + JSON.stringify(r.chips));
        const line = await ev(`(document.querySelector('.team-agents-count') || {}).textContent || ''`);
        assert.equal(line, '2 agents, +1 archived', 'the count line follows the badge and tells the archived one apart (#10369): ' + line);
        assert.ok(r.chips.some(c => /^All\s*2/.test(c)), 'the All chip counts the same two: ' + JSON.stringify(r.chips));
        await ev(`[...document.querySelectorAll('.goals-chip')].find(c => /^Archived/.test(c.textContent.trim())).click(); true`);
        await waitFor(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).length === 1`, 'the archived agent under its chip', { timeout: 8000 });
        console.log('PASS the Agents tab and the sidebar group count the same agents, and the archived one is under its chip'); // the table keeps it there
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
