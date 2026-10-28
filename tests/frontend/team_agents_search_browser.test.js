// The team Agents tab's search finds an agent by its role as well as its name (#8332): it searched a job_title the board's /status never sends (it sends role), so typing a role found nothing.
// The board's /status answer is stubbed with three agents of different roles. 1280 px, through the real team page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-search-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
        await seed(ev, TEAM);
        await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/board/${TEAM}/status') { const a = (name, role) => ({ name, subscriber_id: name, role, agent_type: 'claude', availability: 'available', available: true, reason: 'Idle', tasks: [] });
                const agents = [a('Zed', 'Release Manager'), a('Amy', 'QA Engineer'), a('Bob', 'Docs Writer')];
                return Promise.resolve(new Response(JSON.stringify({ agents, summary: { total: 3, available: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM); await settle(500);
        await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); t.click(); return true; })()`);
        const rows = () => ev(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).map(r => r.querySelector('.dt-primary .dt-person-name').textContent.trim())`) // the agent's name (the button's text also holds a state word for a screen reader after it, #9747);
        await waitFor(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).length === 3`, 'the three agents', 8000);
        const type = async (q) => { await ev(`(() => { const i = document.querySelector('#team-agents-search'); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await settle(400); return rows(); };
        const got = await type('release'); assert.deepEqual(got, ['Zed'], 'a role finds its agent: ' + JSON.stringify(got));
        assert.deepEqual(await type('QA eng'), ['Amy'], 'a part of a role, any case');
        assert.deepEqual(await type('bob'), ['Bob'], 'a name still finds its agent');
        assert.deepEqual(await type('nobody'), [], 'no match, no rows');
        console.log('PASS the Agents tab search finds an agent by its name or its role');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
