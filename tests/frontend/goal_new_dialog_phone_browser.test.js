// The New goal dialog on a phone (#11027, the phone check: narrower than the screen and no title bar, unlike the other phone dialogs): it fills the screen with its title at the top. 390 px, touch; a team made through the
// API on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const BOARD = 'goal-dlg-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
        await Page.navigate({ url: `${BASE}/team/${BOARD}/goals` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`!!document.querySelector('.goals-new') && document.querySelector('.goals-new').getClientRects().length > 0`, 'New goal', 15000);
        await ev(`document.querySelector('.goals-new').click(); true`);
        await waitFor(`!!document.querySelector('dialog.goals-dialog[open]')`, 'the dialog', 5000);
        const r = await ev(`(() => { const d = document.querySelector('dialog.goals-dialog'), b = d.getBoundingClientRect(), h = d.querySelector('h3'), hr = h.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), left: Math.round(b.left), titleTop: Math.round(hr.top - b.top), titleBorder: getComputedStyle(h).borderBottomWidth, iw: innerWidth }; })()`);
        assert.ok(r.w >= r.iw - 1 && r.left <= 1, 'the dialog fills the screen width: ' + JSON.stringify(r));
        assert.ok(r.titleBorder !== '0px', 'its title is a bar with a rule under it, as the other phone dialogs have: ' + JSON.stringify(r));
        console.log('PASS');
    } finally { try { await removeBoards(ev, [BOARD]); } catch (e) {} try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
