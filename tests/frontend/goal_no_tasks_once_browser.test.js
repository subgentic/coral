// A goal with no tasks says "No tasks yet" once (#11027, the phone check: the goal page said it twice, under the title and again in the tasks list). 390 px; a goal made through the API on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const B = 'goal-none-' + Date.now().toString(36), B2 = B + '-solo', B3 = B + '-own';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'orch-s' })).status < 300);
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Nothing yet', outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201, JSON.stringify(g));
        await Page.navigate({ url: `${BASE}/team/${B}/goals/${g.body.id}` }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await waitFor(`/Nothing yet/.test(document.body.innerText) && /No tasks yet/.test(document.body.innerText)`, 'the goal page', 15000);
        const n = await ev(`(document.body.innerText.match(/No tasks yet/g) || []).length`);
        assert.equal(n, 1, 'No tasks yet is said once, not ' + n);
        // #11880: the goal page says who has the goal. The Orchestrator was told when it was made (the server keeps the time, #11866); a team with none says nobody was
        assert.match(await ev(`document.body.innerText`), /No tasks yet\. The Orchestrator was told (just now|\d+ min ago) and has not planned it\./, 'a goal the Orchestrator was told of says so');
        assert.ok((await api('POST', `/api/board/${B2}/subscribe`, { subscriber_id: 'dev', job_title: 'Developer', session_name: 'dev-s' })).status < 300);
        const g2 = await api('POST', `/api/board/${B2}/goals`, { subscriber_id: 'Operator', title: 'Nobody told', outcome: 'o', done_when: 'd' }); assert.equal(g2.status, 201, JSON.stringify(g2));
        await Page.navigate({ url: `${BASE}/team/${B2}/goals/${g2.body.id}` }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await waitFor(`/No tasks yet/.test(document.body.innerText)`, 'the second goal page', 15000);
        assert.match(await ev(`document.body.innerText`), /No tasks yet\. Nobody has been told about this goal\./, 'a goal nobody was told of says so');
        // #11887: a goal the Orchestrator wrote itself says so, not that nobody was told
        assert.ok((await api('POST', `/api/board/${B3}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'orch-s' })).status < 300);
        const g3 = await api('POST', `/api/board/${B3}/goals`, { subscriber_id: 'orch', title: 'Made by the Orchestrator', outcome: 'o', done_when: 'd' }); assert.equal(g3.status, 201, JSON.stringify(g3));
        await Page.navigate({ url: `${BASE}/team/${B3}/goals/${g3.body.id}` }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await waitFor(`/No tasks yet/.test(document.body.innerText)`, 'the Orchestrator own goal page', 15000);
        assert.match(await ev(`document.body.innerText`), /No tasks yet\. The Orchestrator made this goal and has not planned it\./, 'a goal the Orchestrator wrote itself says so');
        // the Copy for an agent button is a button (a border), and when it wraps under the state it starts at the line's own left edge, not 15 px in (#11027)
        const c = await ev(`(() => { const b = document.querySelector('.goals-detail-line .goal-copy-agent'), l = document.querySelector('.goals-detail-line'); if (!l) return null; if (!b) return { inMore: !!document.querySelector('.goal-head-actions .task-more-menu .goal-copy-agent') }; /* a phone: Copy for an agent is in the header's More menu (#13119) */ l.style.width = '120px'; /* narrow enough that the button wraps to a row of its own */ const br = b.getBoundingClientRect(), lr = l.getBoundingClientRect(), first = l.firstElementChild.getBoundingClientRect(); return { border: getComputedStyle(b).borderLeftWidth, wrapped: br.top > first.bottom - 2, dx: Math.round(br.left - lr.left) }; })()`);
        if (c && c.inMore) console.log('   Copy for an agent is in the More menu on a phone'); else {
        assert.ok(c && c.border !== '0px', 'Copy for an agent has a border, so it reads as a button: ' + JSON.stringify(c));
        assert.ok(c.wrapped && c.dx <= 2, 'wrapped under the state it starts at the line\'s left edge: ' + JSON.stringify(c));
        }
        console.log('PASS');
    } finally { try { await removeBoards(ev, [B, B2, B3]); } catch (e) {} try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
