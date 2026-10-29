// A phone's toast does not cover a team page's tab strip (#11026 item 2, the phone check: the "Copied: paste it to an agent" toast sat over Goals, Agents, Tasks and Artifacts). The column starts below the strip.
// 390 px, touch; a team made through the API on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const BOARD = 'toast-tabs-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
        await ev(`T.state.liveSessions = []; T.render.renderLiveSessions([]); window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
        await waitFor(`!!document.getElementById('team-tabs-row') && document.getElementById('team-tabs-row').getClientRects().length > 0`, 'the tab strip', 15000);
        await ev(`(async () => { const n = await import((window.__coralStatic || '/static/') + 'notifications.js'); n.showToast('Copied: paste it to an agent'); return true; })()`);
        await waitFor(`!!document.querySelector('#toast-host > .toast')`, 'the toast', 5000);
        await ev(`Promise.all(document.querySelector('#toast-host > .toast').getAnimations().map(a => a.finished.catch(() => {}))).then(() => true)`);
        const r = await ev(`(() => { const t = document.querySelector('#toast-host > .toast').getBoundingClientRect(), s = document.getElementById('team-tabs-row').getBoundingClientRect(); return { toastTop: Math.round(t.top), toastBottom: Math.round(t.bottom), stripTop: Math.round(s.top), stripBottom: Math.round(s.bottom) }; })()`);
        assert.ok(r.toastTop >= r.stripBottom - 1, 'the toast starts below the tab strip: ' + JSON.stringify(r));
        console.log('PASS');
    } finally { try { await removeBoards(ev, [BOARD]); } catch (e) {} try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
