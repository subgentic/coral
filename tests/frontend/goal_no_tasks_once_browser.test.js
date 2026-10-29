// A goal with no tasks says "No tasks yet" once (#11027, the phone check: the goal page said it twice, under the title and again in the tasks list). 390 px; a goal made through the API on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const B = 'goal-none-' + Date.now().toString(36);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'orch-s' })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Nothing yet', outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201, JSON.stringify(g));
        await Page.navigate({ url: `${BASE}/team/${B}/goals/${g.body.id}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await waitFor(`/Nothing yet/.test(document.body.innerText) && /No tasks yet/.test(document.body.innerText)`, 'the goal page', 15000);
        const n = await ev(`(document.body.innerText.match(/No tasks yet/g) || []).length`);
        assert.equal(n, 1, 'No tasks yet is said once, not ' + n);
        // the Copy for an agent button is a button (a border), and when it wraps under the state it starts at the line's own left edge, not 15 px in (#11027)
        const c = await ev(`(() => { const b = document.querySelector('.goal-copy-agent'), l = document.querySelector('.goals-detail-line'); if (!b || !l) return null; l.style.width = '120px'; /* narrow enough that the button wraps to a row of its own */ const br = b.getBoundingClientRect(), lr = l.getBoundingClientRect(), first = l.firstElementChild.getBoundingClientRect(); return { border: getComputedStyle(b).borderLeftWidth, wrapped: br.top > first.bottom - 2, dx: Math.round(br.left - lr.left) }; })()`);
        assert.ok(c && c.border !== '0px', 'Copy for an agent has a border, so it reads as a button: ' + JSON.stringify(c));
        assert.ok(c.wrapped && c.dx <= 2, 'wrapped under the state it starts at the line\'s left edge: ' + JSON.stringify(c));
        console.log('PASS');
    } finally { try { await removeBoards(ev, [B]); } catch (e) {} try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
