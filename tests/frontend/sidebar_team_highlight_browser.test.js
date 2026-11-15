// #16669 follow-up (#17611): opening team B's page after team A moves the sidebar highlight.
// The board-card-header with team-selected must be team B's, not team A's.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const A = `team-a-${Date.now() % 100000}`;
const B = `team-b-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, A); await seed(ev, B);

        const selected = () => ev(`[...document.querySelectorAll('.board-card-header.team-selected')].map(h => h.dataset.groupName)`);

        // open team A
        await openTeam(ev, waitFor, A);
        const afterA = await selected();
        assert.deepEqual(afterA, [A], 'after opening team A, only A is highlighted: ' + JSON.stringify(afterA));

        // switch to team B's Artifacts tab
        await openTeam(ev, waitFor, B);
        await goTab(ev, settle, 'Artifacts'); await settle(400);
        const afterB = await selected();
        assert.deepEqual(afterB, [B], 'after opening team B Artifacts, only B is highlighted: ' + JSON.stringify(afterB));

        console.log('PASS sidebar highlight follows the team (#16669, #17611)');
    } finally {
        await removeBoards([A, B]);
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
