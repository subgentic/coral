// #20146 (Beta #20145): the team page's tab strip at 1280 has even gaps: the space between one tab's last mark (its label, or its count pill) and the next tab's label is the same for every pair, whether or not a tab has a count. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const TEAM = 'tab-gap-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await installTP(ev); await seed(ev, TEAM);
        await openTeam(ev, waitFor, TEAM);
        await waitFor(`document.querySelectorAll('#team-tabs .team-tab').length >= 4`, 'the tabs', 10000);
        const m = await ev(`(() => [...document.querySelectorAll('#team-tabs .team-tab')].filter(t => t.getClientRects().length).map(t => { const l = t.querySelector('.team-tab-label'), c = t.querySelector('.team-tab-count'), lr = l.getBoundingClientRect(), cr = c ? c.getBoundingClientRect() : null, r = t.getBoundingClientRect(); return { tab: t.dataset.tab, left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, labelLeft: Math.round(lr.left * 10) / 10, last: Math.round(((cr && cr.width ? cr.right : lr.right)) * 10) / 10, count: c ? c.textContent : null, cw: cr ? Math.round(cr.width) : 0 }; }))()`);
        console.log(JSON.stringify(m));
        const gaps = m.slice(1).map((t, i) => Math.round((t.labelLeft - m[i].last) * 10) / 10);
        
        assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, 'the gap from each tab’s last mark to the next label is the same for every pair: ' + JSON.stringify({ gaps, m }));
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    console.log('PASS team tab strip spacing');
})().catch(e => { console.error(e); process.exit(1); });
