// #21751: latest approval is a single press; the version list still names files and older-version warnings remain.
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
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
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
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
        await shot('latest-approval');
        assert.equal(await ev(`document.querySelector('.artifact-review-approve').textContent`), 'Approve');
        assert.equal(await ev(`document.querySelector('.artifact-review-approve').title`), '', 'no covering-files tooltip');
        const names = await ev(`[...document.querySelectorAll('.av-option .av-vname')].map(e => e.textContent).join('|')`);
        assert.equal(names, 'v3 README.md (latest)|v2 style.css|v1 app.js', 'each version of the list names its file');
        await close();
        assert.equal((await api('PUT', `/api/board/${B}/artifacts/${h1}/tags`, { tags: ['for review', 'changes requested'] })).status, 200);
        await openV(h1, '');
        await waitFor(`/is newer/.test(document.querySelector('.av-notice')?.textContent || '')`, 'the older file says the newest covers it', 12000);
        assert.match(await ev(`document.querySelector('.av-notice').textContent`), /README\.md \(v3\) is newer, and one decision on it covers all 3 files/);
        await waitFor(`document.querySelector('.artifact-review-approve')?.textContent === 'Approve this older version'`, 'the older review state finishes loading', 12000);
        assert.equal(await ev(`document.querySelector('.artifact-review-approve').textContent`), 'Approve this older version');
        await close(); await openV(h3, '');
        await waitFor(`!!document.querySelector('.artifact-review-approve') && !document.querySelector('.artifact-review-approve').hidden`, 'the review bar again', 12000);
        await waitFor(`document.querySelector('.artifact-review-approve')?.textContent === 'Approve' && !document.querySelector('.artifact-review-approve').disabled`, 'latest approval ready', 12000);
        await ev(`document.querySelector('.artifact-review-approve').click(); true`);
        await waitFor(`/Approved/.test(document.querySelector('.artifact-review-state')?.textContent || '')`, 'one press approves even with an unopened file', 12000);
        console.log('PASS latest version approves in one press; file names and older-version warnings remain');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
