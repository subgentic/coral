// #16738 (walk 32 F4): the Artifacts tab's strip must not say "open index.html in that folder" for a team
// whose deliverable is not an HTML app.  A board with one CSV file and a folder: the strip says "The team
// works in the folder <path>." with no mention of index.html.  Fails on the parent (the strip said
// "The app runs from there: open index.html in that folder.").
const assert = require('node:assert/strict');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'tfnh-' + Date.now().toString(36);
    const api = (method, p, body, headers) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'CSV QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'CSV QA', job_title: 'Backend Dev', session_name: sname })).status < 300);
        await api('POST', `/api/agent/artifacts?session_id=${sid}`, 'name,score\nAlpha,42\nBeta,88', { 'X-Artifact-Name': 'results.csv', 'X-Artifact-Media-Type': 'text/csv' });
        await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => String(u).includes('/api/teams/detail/') ? Promise.resolve(new Response(JSON.stringify({ working_dir: '/Users/me/Reports/${B}' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : R(u, o); })(); true`);
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length >= 1`, 'the CSV file', 15000);
        await waitFor(`!!document.querySelector('#team-panel-artifacts .team-files-strip')`, 'the folder strip', 8000);
        const strip = await ev(`document.querySelector('#team-panel-artifacts .team-files-strip').textContent`);
        assert.ok(strip.includes(`/Users/me/Reports/${B}`), 'the strip names the team folder: ' + JSON.stringify(strip));
        assert.ok(!/index\.html/i.test(strip), 'the strip does not mention index.html for a non-HTML team (#16738): ' + JSON.stringify(strip));
        assert.ok(!/The app runs from there/.test(strip), 'the strip does not say "The app runs from there" (#16738): ' + JSON.stringify(strip));
        console.log('PASS the Artifacts tab strip does not mention index.html for a non-HTML team');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
