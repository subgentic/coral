// #15233 (Beta walk 11 H2): a task's chain puts several files in ONE series (#12144; the test makes one with renames), so the Needs you row stood for the newest file only and the others could not be seen or told apart. The version list now names
// each file, the review bar says one decision covers all of them, and an older file's notice says so. Unused header of the test it was made from: #15197 (Beta walk 9 H2): the Needs you row opened v1 of a file after the agent had uploaded v2, and "Approve anyway" approved the stale v1 with no word that a newer version existed. Now the review bar names the
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
        const up = async (name, text, h, extra) => { const r = await api('POST', `/api/agent/artifacts?session_id=${sid}${extra || ''}`, text, { 'X-Artifact-Name': name, 'X-Artifact-Media-Type': 'text/plain', ...(h ? { 'X-Artifact-New-Version-Of': 'coral://artifacts/' + h, 'X-Artifact-Rename': '1' } : {}) }); assert.equal(r.status, 201, JSON.stringify(r)); return /[a-f0-9]{64}/.exec(r.body.uri)[0]; };
        const h1 = await up('app.js', 'one', null, '&tag=for+review&question=Approve%3F');
        const h2 = await up('style.css', 'two', h1);
        const h3 = await up('README.md', 'three', h2, '&tag=for+review&question=Approve%3F');
        await openV(h3, '');
        await waitFor(`!!document.querySelector('.artifact-review-approve') && !document.querySelector('.artifact-review-approve').hidden`, 'the review bar is there', 12000);
        assert.equal(await ev(`document.querySelector('.artifact-review-approve').textContent`), 'Approve (covers 3 files)');
        const names = await ev(`[...document.querySelectorAll('.av-option .av-vname')].map(e => e.textContent).join('|')`);
        assert.equal(names, 'v3 README.md (latest)|v2 style.css|v1 app.js', 'each version of the list names its file');
        await close();
        await openV(h1, '');
        await waitFor(`/is newer/.test(document.querySelector('.av-notice')?.textContent || '')`, 'the older file says the newest covers it', 12000);
        assert.match(await ev(`document.querySelector('.av-notice').textContent`), /README\.md \(v3\) is newer, and one decision on it covers all 3 files/);
        // #15254: Approve on the newest asks once when files of the series were never opened, and says how many (app.js and README.md were shown earlier in this test, so one is left); a second press approves
        await close(); await openV(h3, '');
        await waitFor(`!!document.querySelector('.artifact-review-approve') && !document.querySelector('.artifact-review-approve').hidden`, 'the review bar again', 12000);
        await ev(`document.querySelector('.artifact-review-approve').click(); true`);
        assert.equal(await ev(`document.querySelector('.artifact-review-approve').textContent`), '1 of 3 files not opened: approve all?', 'README.md and app.js were shown above; style.css never was');
        assert.equal(await ev(`window.__approved = false, !!document.querySelector('.artifact-review-approve') && /Approved/.test(document.querySelector('.artifact-review-state')?.textContent || '')`), false, 'the first press approved nothing');
        await ev(`document.querySelector('.artifact-review-approve').click(); true`);
        await waitFor(`/Approved/.test(document.querySelector('.artifact-review-state')?.textContent || '')`, 'the second press approves', 12000);
        console.log('PASS a series of several files names each file and says one decision covers them all');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
