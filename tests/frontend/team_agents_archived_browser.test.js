// The team Agents tab says an archived agent is archived (#8194): the server's availability "archived" had no word, so the row's status chip said "No signal yet" (and its filter chip was the raw key,
// lower case, beside "Sleeping"). The board's /status answer is stubbed with a free, a sleeping and an archived agent. 1280 px, through the real team page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-archived-${Date.now() % 100000}`;

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
                const agents = [a('Free One', 'available', 'Idle'), a('Sleeper', 'sleeping', 'Agent is sleeping'), a('Shelved', 'archived', 'Agent is archived; unarchive it before assigning work')];
                return Promise.resolve(new Response(JSON.stringify({ agents, summary: { total: 3, available: 1, sleeping: 1, archived: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM); await settle(500);
        await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); t.click(); return true; })()`);
        await waitFor(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).length === 2`, 'the two live agents (an archived one is under its chip, #10369)', 8000);
        const chips = await ev(`[...document.querySelectorAll('.goals-chip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim())`);
        assert.ok(chips.some(c => /^Archived\b/.test(c)), 'the Archived chip is there: ' + JSON.stringify(chips));
        await ev(`[...document.querySelectorAll('.goals-chip')].find(c => /^Archived/.test(c.textContent.trim())).click(); true`);
        await waitFor(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).length === 1`, 'the archived agent under its chip', 8000);
        const r = await ev(`(() => ({ chips: [...document.querySelectorAll('.goals-chip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim()), shelved: [...document.querySelectorAll('tr.dt-row')].filter(x => /Shelved/.test(x.innerText)).map(x => x.innerText.replace(/\\s+/g, ' '))[0] }))()`);
        assert.ok(r.chips.some(c => /^Archived\b/.test(c)) && !r.chips.some(c => /^archived\b/.test(c)), 'the filter chip says Archived: ' + JSON.stringify(r.chips));
        assert.match(r.shelved, /Archived/, 'the archived agent\'s status says Archived: ' + r.shelved);
        assert.doesNotMatch(r.shelved, /No signal yet/, 'and not "No signal yet": ' + r.shelved);
        console.log('PASS the Agents tab says Archived for an archived agent, on its row and its chip');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
