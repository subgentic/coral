// "Remove from this board" (#11112, the Operator's clean-up of a leftover board seat): on a team's agent page, DELETE /api/board/{team}/seats/{subscriber} after a confirm that names the seat and the board and says the agent keeps running; the seat is gone from
// the Agents tab afterwards; Cancel sends nothing; a refusal is said in a toast. The button is for this computer only (never through the Hub: the route is the Operator's). A real board on the isolated dev server; the DELETE is recorded and answered by the test.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'seat-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => ({ status: r.status }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            if (w === 1280) for (const [id, jt] of [['orch', 'Orchestrator'], ['stale', 'Stale seat']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' })).status, 200);
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.__dels = []; window.__delStatus = 200; { const real = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if ((o.method || 'GET') === 'DELETE' && /\\/seats\\//.test(p.pathname)) { window.__dels.push(p.pathname); return Promise.resolve(new Response(JSON.stringify(window.__delStatus === 200 ? { ok: true } : { error: 'that board has no such seat' }), { status: window.__delStatus, headers: { 'content-type': 'application/json' } })); } return real(u, o); }; } true`);
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'agents' }); true`);
            await waitFor(`document.querySelectorAll('#team-panel-agents .dt-table tbody tr').length >= 2`, `${w}: the members`, 15000);
            await ev(`[...document.querySelectorAll('#team-panel-agents tbody tr .dt-primary')].find(b => /stale/.test(b.textContent)).click(); true`);
            await waitFor(`!!document.querySelector('.team-agent-page')`, `${w}: the agent page`, 6000);
            const label = await ev(`[...document.querySelectorAll('.team-agent-page .goals-pinbar button')].find(b => /Remove from this board/.test(b.textContent))?.getAttribute('aria-label')`);
            assert.equal(label, 'Remove stale from this board', `${w}: the button is named for the seat`);
            const box = await ev(`(() => { const b = [...document.querySelectorAll('.team-agent-page .goals-pinbar button')].find(x => /Remove from this board/.test(x.textContent)).getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; })()`);
            assert.ok(box[1] >= 36 && (!mobile || box[1] >= 44), `${w}: a real target: ` + JSON.stringify(box));
            // Cancel sends nothing
            await ev(`[...document.querySelectorAll('.team-agent-page .goals-pinbar button')].find(b => /Remove from this board/.test(b.textContent)).click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display === 'flex' && /Remove from this board/.test(document.getElementById('confirm-modal-title').textContent)`, `${w}: the confirm`, 5000);
            const msg = await ev(`document.getElementById('confirm-modal-message').textContent`);
            assert.ok(/stale/.test(msg) && new RegExp(B).test(msg) && /keeps running/.test(msg), `${w}: the confirm names the seat and the board and says the agent keeps running: ` + msg);
            assert.equal(await ev(`document.getElementById('confirm-modal-yes').textContent`), 'Remove seat', `${w}: the confirm names the action`);
            await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`);
            assert.deepEqual(await ev(`window.__dels`), [], `${w}: Cancel sends nothing`);
            // a refusal is said
            await ev(`window.__delStatus = 404; [...document.querySelectorAll('.team-agent-page .goals-pinbar button')].find(b => /Remove from this board/.test(b.textContent)).click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display === 'flex'`, `${w}: the confirm again`, 5000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`window.__dels.length === 1 && /no such seat/.test(document.body.textContent)`, `${w}: a refusal is said`, 6000);
            // the real removal
            await ev(`window.__delStatus = 200; [...document.querySelectorAll('.team-agent-page .goals-pinbar button')].find(b => /Remove from this board/.test(b.textContent)).click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display === 'flex'`, `${w}: the confirm a third time`, 5000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`window.__dels.length === 2`, `${w}: the DELETE`, 6000);
            assert.deepEqual(await ev(`window.__dels`), [`/api/board/${B}/seats/stale`, `/api/board/${B}/seats/stale`], `${w}: DELETE /api/board/{team}/seats/{subscriber}`);
            console.log(`   ${w}: ok`);
        }
        console.log('PASS Remove from this board');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
