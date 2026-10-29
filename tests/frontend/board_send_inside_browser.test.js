// The Board's Send button stays inside the composer's rounded end on a phone (#10942 item 10, the phone pass: it overhung the border). The card's end curve is 22 px and Send sits 3 px inside, so its own corners
// are rounded to the 19 px that fit; checked as geometry: each of Send's right corners is inside the card's rounded outline. 390 px; a real board over the API on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'send-inside-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        assert.equal(await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-s' }), 200);
        assert.equal(await api('POST', `/api/board/${B}/messages`, { subscriber_id: 'Boss', content: 'Hello.' }), 200);
        await Page.navigate({ url: `${BASE}/team/${B}/messages` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`!!document.querySelector('.mb-post-send-btn') && document.querySelector('.mb-post-send-btn').getClientRects().length > 0`, 'the composer', 15000);
        const g = await ev(`(() => { const card = document.querySelector('.mb-post-card'), b = document.querySelector('.mb-post-send-btn'), c = card.getBoundingClientRect(), r = b.getBoundingClientRect(); const R = parseFloat(getComputedStyle(card).borderTopRightRadius), br = parseFloat(getComputedStyle(b).borderTopRightRadius);
            // the card's outline near its right end: a corner point of Send is inside when it is inside the quarter circle of radius R at the card's top right and bottom right
            const inside = (x, y) => { const cx = c.right - R, cy = y < c.top + c.height / 2 ? c.top + R : c.bottom - R; return x <= cx || Math.hypot(x - cx, y - cy) <= R - 1; };
            // Send's rounded corner, not its square one: the nearest point of its own outline to the card's corner
            const pts = [[r.right - br + br * Math.SQRT1_2, r.top + br - br * Math.SQRT1_2], [r.right - br + br * Math.SQRT1_2, r.bottom - br + br * Math.SQRT1_2]];
            return { R, br, card: [c.top, c.bottom, c.right], btn: [r.top, r.bottom, r.right], ok: pts.every(p => inside(p[0], p[1])) }; })()`);
        assert.ok(g.br >= 17 && g.ok, 'Send is rounded to the card\'s curve and inside it: ' + JSON.stringify(g));
        console.log('PASS');
    } finally { try { await removeBoards(ev, [B]); } catch (e) {} try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
