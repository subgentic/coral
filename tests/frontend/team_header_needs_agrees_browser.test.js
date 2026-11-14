// The team page's header says how many need the person with the SAME number as its Needs you tab (#17067, walk 48 F2/F9, #16548's rule): the board's two waiting agents and one thing to review were "2 need attention" in the
// header and 1 on the tab. The header takes the tab's count once it is complete. The board reads are stubbed in the page. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const TEAM = 'needs-agree-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await installTP(ev); await seed(ev, TEAM);
        await ev(`globalThis.__coralAttentionGraceMs = 0; { const real = window.fetch; window.fetch = (u, o = {}) => { const url = new URL(String(u), location.href), p = url.pathname, json = (b) => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } }));
            if (p === '/api/board/${TEAM}/status') return json({ agents: [1, 2].map(i => ({ session_id: 'sid-' + i, subscriber_id: 'Agent ' + i, name: 'Agent ' + i, availability: 'needs_input' })) });
            if (p === '/api/team-artifacts') return json({ total: 1, items: [], partial: false, truncated: false, failed_boards: [] });
            return real(u, o); }; } true`);
        await openTeam(ev, waitFor, TEAM);
        await waitFor(`(document.querySelector('#team-tab-needs .team-tab-count') || {}).textContent === '1'`, 'the Needs you tab says 1', 10000);
        await waitFor(`/attention/.test((document.getElementById('team-page-status') || {}).textContent || '')`, 'the header says how many need attention', 10000);
        const header = await ev(`document.getElementById('team-page-status').textContent`);
        assert.equal(header, '1 needs attention', 'the header says what the Needs you tab says (1), not the two agents the board counts: ' + header);
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    console.log('PASS the team header and the Needs you tab count the same');
})().catch(e => { console.error(e); process.exit(1); });
