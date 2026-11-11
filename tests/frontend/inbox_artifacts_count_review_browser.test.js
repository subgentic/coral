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
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Count QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Count QA', job_title: 'Backend Dev', session_name: sname })).status < 300);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await waitFor(`!!document.querySelector('.view-list-item[data-key="artifacts"]')`, 'the Artifacts folder', 10000);
        const before = Number(/(\d+)\s*$/.exec((await folderText()).trim())?.[1] || 0);
        const up = await api('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review&question=Approve+the+README%3F`, '# Flashcards\nOpen index.html', { 'X-Artifact-Name': 'README.md', 'X-Artifact-Media-Type': 'text/markdown' });
        assert.equal(up.status, 201, JSON.stringify(up));
        await waitFor(`(() => { const t = (document.querySelector('.view-list-item[data-key="artifacts"]') || {}).textContent || ''; const m = /(\\d+)\\s*$/.exec(t.trim()); return m && Number(m[1]) === ${before + 1}; })()`, `the folder counts the README in review (it was ${before})`, 60000);
        console.log('PASS the Artifacts folder counts a file that is waiting for review');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
