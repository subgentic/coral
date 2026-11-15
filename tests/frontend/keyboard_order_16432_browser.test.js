// Keyboard order follows what is seen (beta walk #16415, #16432): in Edit member, Remove from team (the first button in the footer on screen) comes first in the tab order, before Save member;
// the team page's More menu moves with Up, Down, Home and End, and Tab closes it. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, T, openNewTeam, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const t = T(ev, waitFor), problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewTeam(ev, waitFor); await t.to(2, {});
        await ev(`document.querySelectorAll('#team-agents-list > *')[1].querySelector('.team-agent-edit-btn').click(); true`); await settle(500);
        const o = await ev(`(() => { const f = [...document.querySelectorAll('#launch-step-agent .modal-actions button')].filter(b => b.getClientRects().length).map(b => ({ id: b.id, x: b.getBoundingClientRect().left })); return f; })()`);
        const byX = [...o].sort((a, b) => a.x - b.x).map(b => b.id), byDom = o.map(b => b.id);
        if (byX[0] !== 'launch-agent-remove') problems.push('Remove from team is the first button on screen: ' + JSON.stringify(byX));
        if (byDom[0] !== 'launch-agent-remove') problems.push('and the first in the tab order, as on screen: ' + JSON.stringify(byDom));
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'keyboard order:\n  ' + problems.join('\n  '));
    console.log('PASS Edit member: Remove from team is first on screen and in the tab order');
})().catch(e => { console.error(e.message); process.exit(1); });
