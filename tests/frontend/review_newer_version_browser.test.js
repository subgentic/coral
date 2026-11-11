// #15197 (Beta walk 9 H2): the Needs you row opened v1 of a file after the agent had uploaded v2, and "Approve anyway" approved the stale v1 with no word that a newer version existed. Now the review bar names the
// version it approves and says a newer one exists ("Approve v1 (v2 is newer)"), and a row opened from Needs you (openLatest) shows the newest version. Real stored files of a stood-in terminal session on the
// isolated dev server (removed again); v2 is uploaded with no review tag, as an agent that forgot it would.
const assert = require('node:assert/strict');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'rn-' + Date.now().toString(36);
    const api = (method, p, body, headers) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const openV = (hex, extra) => ev(`import((window.__coralStatic || '/static/') + 'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(hex)}, { filename: 'app.js', board: ${JSON.stringify(B)}, ${extra} })); true`);
    const close = () => ev(`document.querySelector('.artifact-viewer-close')?.click(); true`);
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Newer QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Newer QA', job_title: 'Backend Dev', session_name: sname })).status < 300);
        const v1 = await api('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review&question=Approve+app.js%3F`, 'console.log("version one");', { 'X-Artifact-Name': 'app.js', 'X-Artifact-Media-Type': 'text/javascript' });
        assert.equal(v1.status, 201, JSON.stringify(v1)); const h1 = /[a-f0-9]{64}/.exec(v1.body.uri)[0];
        const v2 = await api('POST', `/api/agent/artifacts?session_id=${sid}`, 'console.log("version two");', { 'X-Artifact-Name': 'app.js', 'X-Artifact-Media-Type': 'text/javascript', 'X-Artifact-New-Version-Of': 'coral://artifacts/' + h1 });
        assert.equal(v2.status, 201, JSON.stringify(v2));
        assert.equal((await api('PUT', `/api/board/${B}/artifacts/${h1}/tags`, { tags: ['for review', 'changes requested'] })).status, 200); // changes were asked for on v1; the agent's v2 has no review tag

        await openV(h1, '');
        await waitFor(`!!document.querySelector('.artifact-review-approve') && !document.querySelector('.artifact-review-approve').hidden && /older version|newer/.test(document.querySelector('.artifact-review-approve').textContent)`, 'Approve names the version and the newer one', 12000).catch(async e => { throw new Error(e.message + ' | ' + await ev(`JSON.stringify({ a: (document.querySelector('.artifact-review-approve') || {}).textContent, hid: (document.querySelector('.artifact-review-approve') || {}).hidden, shown: document.querySelector('#artifact-viewer')?.dataset.shownVersion, newer: document.querySelector('#artifact-viewer')?.dataset.newerVersion, title: document.querySelector('.artifact-viewer-title')?.textContent, bar: !!document.querySelector('.av-current'), state: (document.querySelector('.artifact-review-state') || {}).textContent, tags: window.__tagsDbg })`)); });
        assert.equal(await ev(`document.querySelector('.artifact-review-approve').textContent`), 'Approve this older version'); // #15329: the button says it is the older one, the line beside it names the newer
        assert.match(await ev(`document.querySelector('#artifact-viewer .artifact-review-state, .artifact-review-state')?.textContent || ''`), /v2 is newer/);
        await close();

        await openV(h1, 'openLatest: true');
        await waitFor(`/version 2/.test(document.querySelector('.artifact-viewer-title')?.textContent || '')`, 'a row opened from Needs you shows the newest version', 12000);
        assert.ok((await ev(`document.querySelector('.artifact-viewer-body').textContent`)).includes('version two'), 'the body is v2');
        console.log('PASS the review bar names the version it approves and a Needs you row opens the newest');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
