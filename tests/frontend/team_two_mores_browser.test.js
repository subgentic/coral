// The team page has two different "More"s on a phone: the header's (Add agent, Settings) and the tab strip's (the tabs that do not fit, Board among them) (#10942 item 4, the phone pass, checked on :8476: #team-page-more and
// #team-tab-more both read "More"). The header's is "Actions" now, so no two controls on the page share the name. 390 px; a team made through the API on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const BOARD = 'two-mores-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
        await ev(`T.state.liveSessions = []; T.render.renderLiveSessions([]); window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
        await waitFor(`!!document.getElementById('team-page-more') && document.getElementById('team-page-more').getClientRects().length > 0`, 'the header button', 15000);
        const names = await ev(`[...document.querySelectorAll('button, a, [role=tab]')].filter(e => e.getClientRects().length).map(e => e.textContent.trim().replace(/\\s+/g, ' ')).filter(Boolean)`);
        const dup = names.filter((n, i) => names.indexOf(n) !== i && /^More\b/.test(n));
        assert.deepEqual(dup, [], 'no two controls on the team page read More: ' + JSON.stringify(names.filter(n => /More|Actions/.test(n))));
        assert.equal(await ev(`document.getElementById('team-page-more').textContent.trim()`), 'Actions', 'the header button says Actions');
        console.log('PASS');
    } finally { try { await removeBoards(ev, [BOARD]); } catch (e) {} try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
