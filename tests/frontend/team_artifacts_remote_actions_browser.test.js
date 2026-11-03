// Keep, Star and Delete on the team page's Artifacts go to the computer the file is on, and Delete never goes to the wrong one (#12617, the Orchestrator: delete on another computer is the one that can hurt). On this computer's team the three go
// to the plain /api/artifacts/<id> paths; on a registered computer's team only Star is offered (Keep and Delete are this computer's store's, shown only when the list is this computer's), it goes to that computer's /api/remote/<id>/api/
// path, and no Keep or Delete request is made at all, to either computer. A real file on a real board of the isolated dev server (removed again) for this computer; a list copied from it for the other computer, stubbed in the page.
const assert = require('node:assert/strict');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'ra-' + Date.now().toString(36);
    let sid = null, sname = null;
    const api = (method, path, body, headers) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const buttons = () => ev(`[...document.querySelectorAll('button')].filter(b => b.getClientRects().length).map(b => b.textContent.trim())`);
    const press = label => ev(`(() => { const b = [...document.querySelectorAll('button')].filter(b => b.getClientRects().length).find(b => b.textContent.trim() === ${JSON.stringify(label)}); b.click(); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Remote QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Remote QA', job_title: 'Backend Dev', session_name: sname })).status < 300);
        const up = await api('POST', `/api/agent/artifacts?session_id=${sid}`, 'a file ' + Date.now(), { 'X-Artifact-Name': 'plan.txt', 'X-Artifact-Media-Type': 'text/plain' });
        assert.equal(up.status, 201, JSON.stringify(up));
        const hex = /[a-f0-9]{64}/.exec(up.body.uri)[0];
        const real = (await api('GET', `/api/board/${B}/artifacts?limit=50`)).body;
        const item = real.artifacts.find(a => a.id === hex || (a.uri || '').includes(hex));
        assert.ok(item, 'the file is listed');
        await ev(`window.__calls = []; const orig = window.fetch.bind(window); window.fetch = (u, o) => { const url = String(u), m = (o && o.method) || 'GET'; if (m !== 'GET') window.__calls.push(m + ' ' + url.replace(/\\?.*/, '')); return orig(u, o); }; true`);

        // this computer's team: Keep and Delete are offered and go to the plain paths
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 1`, 'the file of this computer\'s team', 15000);
        await ev(`document.querySelector('#team-panel-artifacts [data-artifact-id]').click(); true`);
        await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Delete' && b.getClientRects().length)`, 'Delete in this computer\'s file', 10000);
        let b = await buttons();
        assert.ok(b.includes('Star') && (b.includes('Keep') || b.includes('Kept')) && b.includes('Delete'), 'this computer\'s file offers Star, Keep and Delete: ' + JSON.stringify(b));
        await press('Keep');
        await waitFor(`window.__calls.some(c => /\\/keep$/.test(c))`, 'the keep request', 6000);
        await press('Star');
        await waitFor(`window.__calls.some(c => /\\/star$/.test(c))`, 'the star request', 6000);
        await press('Delete');
        await waitFor(`!!document.querySelector('.modal-content button.btn-danger, dialog[open] button.btn-danger, .confirm-modal button.btn-danger')`, 'the confirmation', 6000).catch(() => {});
        await ev(`(() => { const c = [...document.querySelectorAll('button')].filter(b => b.getClientRects().length && /^(Delete|Confirm|Yes)/.test(b.textContent.trim())).pop(); if (c) c.click(); return true; })()`);
        await waitFor(`window.__calls.some(c => /^DELETE /.test(c))`, 'the delete request', 8000);
        const mine = await ev(`window.__calls`);
        assert.ok(mine.includes(`PUT /api/artifacts/${hex}/keep`) && mine.includes(`PUT /api/artifacts/${hex}/star`) && mine.includes(`DELETE /api/artifacts/${hex}`), 'on this computer all three are plain paths: ' + JSON.stringify(mine));
        assert.ok(!mine.some(c => /\/api\/remote\//.test(c)), 'nothing went to another computer from this computer\'s team: ' + JSON.stringify(mine));

        // another computer's team: only Star, and it goes there; Keep and Delete are never asked
        const other = 'cd'.repeat(32);
        await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); state.hub = true; state.servers = [{ id: 'box-1', status: 'online' }];
            window.__calls = []; const orig = window.fetch.bind(window); window.__origFetch = orig; const item = ${JSON.stringify(item)}; item.id = ${JSON.stringify(other)}; item.uri = 'coral://artifacts/${other}'; item.name = 'remote plan.txt';
            window.fetch = (u, o) => { const url = String(u), m = (o && o.method) || 'GET'; if (m !== 'GET') { window.__calls.push(m + ' ' + url.replace(/\\?.*/, '')); return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                if (/^\\/api\\/remote\\/box-1\\/api\\/board\\/rteam\\/artifacts/.test(url)) return Promise.resolve(new Response(JSON.stringify({ project: 'rteam', artifacts: [item], total: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return orig(u, o); }; return true; })()`);
        await ev(`window.openTeamPage('@box-1/rteam', { tab: 'artifacts' }); true`);
        await waitFor(`!!document.querySelector('#team-panel-artifacts [data-artifact-id]') && /remote plan/.test(document.querySelector('#team-panel-artifacts [data-artifact-id]').textContent)`, 'the file of the other computer\'s team', 15000);
        await ev(`document.querySelector('#team-panel-artifacts [data-artifact-id]').click(); true`);
        await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Star' && b.getClientRects().length)`, 'Star on the other computer\'s file', 10000);
        b = await buttons();
        assert.ok(!b.includes('Keep') && !b.includes('Kept') && !b.includes('Delete'), 'the other computer\'s file offers no Keep or Delete: ' + JSON.stringify(b));
        await press('Star');
        await waitFor(`window.__calls.some(c => /\\/star$/.test(c))`, 'the other computer\'s star request', 6000);
        await ev(framesJs(10));
        const theirs = await ev(`window.__calls`);
        assert.deepEqual(theirs, [`PUT /api/remote/box-1/api/artifacts/${other}/star`], 'only a star, on that computer: ' + JSON.stringify(theirs));
    } finally {
        await ev(`if (window.__origFetch) window.fetch = window.__origFetch; true`).catch(() => {}); // the stub swallowed every write: the clean-up below must reach the server
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
    console.log('team_artifacts_remote_actions_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
