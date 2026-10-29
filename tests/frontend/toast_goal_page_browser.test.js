// A phone's toast does not cover a goal page's way back or its title (#11034 item 4, the phone re-check: "Copied: paste it to an agent" covered "← Goals" and the title). 390 px, touch; a goal made through the API.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const B = 'toast-goal-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'orch-s' })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'A goal with a title', outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201, JSON.stringify(g));
        await Page.navigate({ url: `${BASE}/team/${B}/goals/${g.body.id}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`!!document.querySelector('.goals-detail-title') && document.querySelector('.goals-detail-title').getClientRects().length > 0`, 'the goal page', 15000);
        await ev(`(async () => { const n = await import((window.__coralStatic || '/static/') + 'notifications.js'); n.showToast('Copied: paste it to an agent'); return true; })()`);
        await waitFor(`!!document.querySelector('#toast-host > .toast')`, 'the toast', 5000);
        await ev(`Promise.all(document.querySelector('#toast-host > .toast').getAnimations().map(a => a.finished.catch(() => {}))).then(() => true)`);
        const r = await ev(`(() => { const t = document.querySelector('#toast-host > .toast').getBoundingClientRect(), q = s => { const e = document.querySelector(s); return e && e.getClientRects().length ? Math.round(e.getBoundingClientRect().bottom) : 0; }; return { toastTop: Math.round(t.top), back: q('.goal-back-row, .goals-back'), title: q('.goals-detail-title') }; })()`);
        assert.ok(r.toastTop >= Math.max(r.back, r.title) - 1, 'the toast starts below the goal page\'s way back and title: ' + JSON.stringify(r));
        console.log('PASS');
    } finally { try { await removeBoards(ev, [B]); } catch (e) {} try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
