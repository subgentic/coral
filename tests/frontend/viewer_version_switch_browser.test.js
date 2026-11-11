// #15636 (Security's SHOULD on #15629): choosing another version put its title, version and review target on screen before its bytes arrived, so "Approve v2" sat over v1's text. On a switch the body now says
// "Loading..." and Approve stays disabled until the new content has rendered. Real stored files of a stood-in terminal session on the isolated dev server (removed again); v2's content is answered 1.5 s late.
const assert = require('node:assert/strict');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'vs-' + Date.now().toString(36);
    const api = (method, p, body, headers) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const openV = (hex, extra) => ev(`import((window.__coralStatic || '/static/') + 'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(hex)}, { filename: 'app.js', board: ${JSON.stringify(B)}, ${extra} })); true`);
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Switch QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Switch QA', job_title: 'Backend Dev', session_name: sname })).status < 300);
        const v1 = await api('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review&question=Approve+app.js%3F`, 'console.log("version one");', { 'X-Artifact-Name': 'app.js', 'X-Artifact-Media-Type': 'text/javascript' });
        assert.equal(v1.status, 201, JSON.stringify(v1)); const h1 = /[a-f0-9]{64}/.exec(v1.body.uri)[0];
        const v2 = await api('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review&question=Approve+app.js+v2%3F`, 'console.log("version two");', { 'X-Artifact-Name': 'app.js', 'X-Artifact-Media-Type': 'text/javascript', 'X-Artifact-New-Version-Of': 'coral://artifacts/' + h1 });
        assert.equal(v2.status, 201, JSON.stringify(v2)); const h2 = /[a-f0-9]{64}/.exec(v2.body.uri)[0];

        assert.equal((await api('PUT', `/api/board/${B}/artifacts/${h1}/tags`, { tags: ['for review', 'changes requested'] })).status, 200); // v1 is waiting for a decision again (as in review_newer_version): Approve is there on v1 and on v2
        assert.equal((await api('PUT', `/api/board/${B}/artifacts/${h2}/tags`, { tags: ['for review'] })).status, 200);
        await openV(h1, '');
        await waitFor(`(document.querySelector('.artifact-viewer-body')?.textContent || '').includes('version one') && !!document.querySelector('.artifact-review-approve') && !document.querySelector('.artifact-review-approve').hidden && !document.querySelector('.artifact-review-approve').disabled`, 'v1 is shown and Approve is ready', 12000).catch(async e => { throw new Error(e.message + ' | ' + await ev(`JSON.stringify({ body: (document.querySelector('.artifact-viewer-body')?.textContent || '').slice(0, 80), approve: (() => { const a = document.querySelector('.artifact-review-approve'); return a && { hidden: a.hidden, disabled: a.disabled, text: a.textContent }; })(), pending: document.querySelector('.artifact-viewer')?.dataset?.contentPending, state: document.querySelector('.artifact-review-state')?.textContent })`)); });
        // v2's content arrives late: the person picks the next version
        await ev(`(() => { const f = window.fetch.bind(window); window.fetch = (u, o) => { const url = String(u && u.url || u); return /${h2}/.test(url) && !/versions/.test(url) ? new Promise(r => setTimeout(r, 1500)).then(() => f(u, o)) : f(u, o); }; return true; })()`); // sleep-ok: a deliberate slow answer from the server is the condition under test
        await ev(`document.querySelector('.av-next').click(); true`);
        await waitFor(`/version 2/.test(document.querySelector('.artifact-viewer-title')?.textContent || '')`, 'the title names version 2', 8000);
        const mid = await ev(`(() => { const a = document.querySelector('.artifact-review-approve'), b = document.querySelector('.artifact-viewer-body'); return { text: b.textContent, approveDisabled: a.disabled, withNoteDisabled: document.querySelector('.artifact-review-approve-note').disabled, pending: document.querySelector('dialog.artifact-viewer, .artifact-viewer')?.dataset.contentPending || '' }; })()`);
        assert.ok(!mid.text.includes('version one'), 'the old text is gone while v2 loads: ' + JSON.stringify(mid));
        assert.ok(/Loading/.test(mid.text), 'the body says it is loading: ' + JSON.stringify(mid));
        assert.equal(mid.approveDisabled, true, 'Approve is held until v2 has rendered: ' + JSON.stringify(mid));
        assert.equal(mid.withNoteDisabled, true, "the comment form's Approve (approveWith, #15545) is held too: " + JSON.stringify(mid));
        await waitFor(`(document.querySelector('.artifact-viewer-body')?.textContent || '').includes('version two')`, 'v2 renders', 12000);
        await waitFor(`!document.querySelector('.artifact-review-approve-note').disabled`, "the form's Approve is ready once v2 is on screen", 5000);
        await waitFor(`!document.querySelector('.artifact-review-approve').disabled`, 'Approve is ready once v2 is on screen', 5000);
        console.log('PASS a version switch clears the old text and holds Approve until the new content has rendered');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
