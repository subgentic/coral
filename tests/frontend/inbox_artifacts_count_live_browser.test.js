// #15645: the same folder count, with the page's live feed attached (the harness detaches it): another team's upload reaches the count through the revision feed within seconds, not at the 20 s safety read.
// #15176 (Beta walk 7): the Inbox sidebar said "Artifacts 0" while a README sat in review. The folder's count is every file of every team, those waiting for review included: a file uploaded for review is
// counted (1) as soon as the Inbox opens and the count follows a second upload. Real stored files uploaded by a stood-in terminal session of a real board on the isolated dev server (removed again).
const assert = require('node:assert/strict');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'ac-' + Date.now().toString(36);
    const api = (method, p, body, headers) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const folderText = () => ev(`(document.querySelector('.view-list-item[data-key="artifacts"]') || {}).textContent || ''`);
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`window.T.ws.connectCoralWs(); true`); // the harness detached the feed on install: the real one, as a dashboard has it
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Count QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Count QA', job_title: 'Backend Dev', session_name: sname })).status < 300);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`!!document.querySelector('.view-list-item[data-key="artifacts"]')`, 'the Artifacts folder', 10000);
        // The file is named and written per run: the repeat job runs this suite ten times on one server, and a README.md with the same name and text as the last run's added no row, so the server's total stayed at 1 and the wait for 2 timed out (#15630, Linux repeats). The baseline is the server's own total, read before the upload
        const serverAll = async () => (await api('GET', '/api/team-artifacts?limit=1&versions=newest&offset=0')).body.all;
        const before = await serverAll();
        // What the page asked for after the upload, kept for the failure message: the count follows the revision feed or, for a team the page is not showing, the 20 s safety read (artifact count poll in inbox_artifacts.js), so a miss needs to say which of them did not run (#15630: it timed out once at 60 s on Windows and passed on a fresh browser)
        await ev(`window.__rq = []; window.__t0 = Date.now(); { const f = window.fetch; window.fetch = function (u, o) { const s = String((u && u.url) || u); if (/artifact|\\/status/.test(s)) window.__rq.push(((Date.now() - window.__t0) / 1000).toFixed(1) + 's ' + ((o && o.method) || 'GET') + ' ' + s.slice(0, 90)); return f.apply(this, arguments); }; } true`);
        const up = await api('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review&question=Approve+the+README%3F`, `# Flashcards ${B}\nOpen index.html`, { 'X-Artifact-Name': `README-${B}.md`, 'X-Artifact-Media-Type': 'text/markdown' });
        assert.equal(up.status, 201, JSON.stringify(up));
        try {
            await waitFor(`fetch('/api/team-artifacts?limit=1&versions=newest&offset=0').then(r => r.json()).then(j => { const m = /(\\d+)\\s*$/.exec(((document.querySelector('.view-list-item[data-key="artifacts"]') || {}).textContent || '').trim()); return j.all >= ${before + 1} && !!m && Number(m[1]) === j.all; })`, `the folder counts the README in review within 8 s, by the feed (the server's total was ${before} before the upload)`, 8000);
        } catch (e) {
            const seen = await ev(`JSON.stringify({ visible: document.visibilityState, hidden: document.hidden, folder: ((document.querySelector('.view-list-item[data-key="artifacts"]') || {}).textContent || '').trim(), requests: window.__rq })`).catch(x => 'unreadable: ' + x.message);
            throw new Error(e.message + ' | the server total now: ' + await serverAll().catch(() => '?') + ' | the page after the upload: ' + seen);
        }
        console.log('PASS the Artifacts folder follows another team\'s upload through the live feed');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
