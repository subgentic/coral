// #18034 (walk 77 item 1): closing a goal as Done offers Distill knowledge in one click (a toast with the button); closing it as Dropped offers nothing. The click asks the server to distill, which the page stubs (no run is started).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const boards = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        for (const as of ['done', 'dropped']) {
            const board = `goal-distill-${as}-` + Date.now().toString(36); boards.push(board);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
            const g = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Operator', title: 'Close me', outcome: 'One goal', done_when: 'A person chooses' }); assert.equal(g.status, 201); const id = g.body.id;
            assert.equal((await api('PATCH', `/api/board/${board}/goals/${id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
            await Page.navigate({ url: BASE + `/inbox/goals/${board}/${id}` }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(() => { window.__distill = []; const R = window.fetch; window.fetch = (u, o = {}) => { if (/distill-knowledge/.test(String(u && u.url || u)) && (o.method || 'GET') === 'POST') { window.__distill.push(String(u)); return Promise.resolve(new Response(JSON.stringify({ status: 'running', progress: { phase: 'starting' } }), { status: 202, headers: { 'content-type': 'application/json' } })); } return R(u, o); }; return true; })()`);
            await waitFor(`!!document.querySelector('#inbox-page .goals-close')`, as + ': the goal page', 15000);
            await ev(`document.querySelector('#inbox-page .goals-close').click(); true`);
            await waitFor(`!!document.querySelector('.goals-close-dialog[open]')`, as + ': the Close dialog', 5000);
            await ev(`document.querySelector('.goals-close-dialog input[value="${as}"]').click(); document.querySelector('.goals-close-dialog button[type="submit"]').click(); true`);
            await waitFor(`!!document.querySelector('#inbox-page .goals-reopen')`, as + ': the goal closes', 8000);
            if (as === 'done') {
                await waitFor(`!!document.querySelector('#toast-host .toast .toast-action, #toast-host .toast button')`, 'the offer', 5000);
                const offer = await ev(`[...document.querySelectorAll('#toast-host .toast')].map(t => t.textContent).join(' | ')`);
                assert.match(offer, /Distill what the team learned/, offer); assert.match(offer, /Distill knowledge/, offer);
                assert.equal(await ev(`window.__distill.length`), 0, 'the offer starts nothing by itself');
                await ev(`[...document.querySelectorAll('#toast-host .toast button')].find(b => /Distill knowledge/.test(b.textContent)).click(); true`);
                await waitFor(`window.__distill.length === 1`, 'one click asks the server to distill', 5000);
                assert.match(await ev(`window.__distill[0]`), new RegExp(`/api/teams/detail/${board}/distill-knowledge`), 'for this team');
            } else {
                await new Promise(r => setTimeout(r, 600)); // sleep-ok: absence check, the offer would appear within this window
                assert.doesNotMatch(await ev(`[...document.querySelectorAll('#toast-host .toast')].map(t => t.textContent).join(' | ')`), /Distill/, 'a dropped goal offers nothing');
            }
        }
        console.log('\nPASS closing a goal as done offers Distill knowledge, as dropped does not');
    } finally { await removeBoards(ev, boards).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
