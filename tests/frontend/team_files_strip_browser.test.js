// #15154 (Beta walk 5): a newcomer could not run the app the team built from the dashboard. The team's Artifacts tab now says where the team's folder is (with Copy path), has Download all (one zip of the
// files the list shows), and a "superseded" chip says what it means. Real stored files uploaded by a stood-in terminal session of a real board on the isolated dev server (removed again); the folder
// is stood in (fetch of the team's record) and the saved file is caught at the download click, then read back by Python's zipfile.
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('./helpers/child_process');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { safePaused } = require('./helpers/paused');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'tf-' + Date.now().toString(36);
    const api = (method, p, body, headers) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Files QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Files QA', job_title: 'Backend Dev', session_name: sname })).status < 300);
        const up = async (name, text, type) => { const r = await api('POST', `/api/agent/artifacts?session_id=${sid}`, text, { 'X-Artifact-Name': name, 'X-Artifact-Media-Type': type }); assert.equal(r.status, 201, JSON.stringify(r)); return /[a-f0-9]{64}/.exec(r.body.uri)[0]; };
        const hIndex = await up('index.html', '<h1>Flashcards</h1><script src="app.js"></script>', 'text/html');
        await up('app.js', 'console.log("flashcards " + Date.now());', 'text/javascript');
        await up('README.md', '# Flashcards\nOpen index.html', 'text/markdown');
        // the folder of the team's record, and every file the page saves is kept here instead of going to a download
        await ev(`window.__saved = []; window.__blobs = new Map(); const mk = URL.createObjectURL; URL.createObjectURL = b => { const u = mk.call(URL, b); window.__blobs.set(u, b); return u; }; (() => { const R = window.fetch; window.fetch = (u, o) => String(u).includes('/api/teams/detail/') ? new Promise(res => setTimeout(() => res(new Response(JSON.stringify({ working_dir: '/Users/me/Coral/${B}' }), { status: 200, headers: { 'Content-Type': 'application/json' } })), window.__detailDelay || 0)) : R(u, o); const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download && /^blob:/.test(this.href)) { const a = this, blob = window.__blobs.get(a.href); blob.arrayBuffer().then(b => { window.__saved.push({ name: a.download, b64: btoa(String.fromCharCode(...new Uint8Array(b))) }); }); return; } return click.call(this); }; window.__copied = []; navigator.clipboard.writeText = async t => { window.__copied.push(t); }; })(); true`); // sleep-ok: the team record answer is held on purpose, to see the page before it comes
        // the strip's module fails to load (#15624): the held space goes with it, the table moves up once and nothing is left hidden above it
        await client.Fetch.enable({ patterns: [{ urlPattern: '*artifact_team_files.js', requestStage: 'Request' }] });
        safePaused(client, p => client.Fetch.failRequest({ requestId: p.requestId, errorReason: 'Failed' }));
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 3`, 'the three files with the strip module failing', 15000);
        await waitFor(`!document.querySelector('#team-panel-artifacts .team-files-strip-host')`, 'the failed strip removes its placeholder', 8000);
        assert.equal(await ev(`document.querySelectorAll('#team-panel-artifacts .team-files-strip, #team-panel-artifacts .team-files-strip-reserve').length`), 0, 'no strip and no reserved gap after the failure');
        await client.Fetch.disable();
        await ev(`window.__detailDelay = 1500; window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 3`, 'the three files', 15000);
        // the strip loads late (its module, then the team's record): the table must not move when it arrives (#15618, the table sat 70 px lower after it, and team_bulk's long press missed)
        await waitFor(`!!document.querySelector('#team-panel-artifacts .team-files-strip-host')`, 'the strip holds its place', 8000);
        const rowTop = () => ev(`Math.round(document.querySelector('#team-panel-artifacts [data-artifact-id]').getBoundingClientRect().top)`);
        const before = await rowTop(), held = await ev(`(() => { const h = document.querySelector('#team-panel-artifacts .team-files-strip-host'); return { real: !!h.querySelector('.team-files-strip'), height: Math.round(h.getBoundingClientRect().height), hidden: getComputedStyle(h).visibility, aria: h.getAttribute('aria-hidden') }; })()`);
        assert.ok(!held.real && held.height >= 30 && held.hidden === 'hidden' && held.aria === 'true', 'before the answer the strip is a held, unseen, silent space: ' + JSON.stringify(held));
        await waitFor(`!!document.querySelector('#team-panel-artifacts .team-files-strip')`, 'the folder strip', 8000);
        const after = await rowTop();
        assert.ok(Math.abs(after - before) <= 1, `the first row does not move when the strip arrives (${before} -> ${after})`);
        const strip = await ev(`(() => { const s = document.querySelector('#team-panel-artifacts .team-files-strip'); return { text: s.textContent, buttons: [...s.querySelectorAll('button')].map(b => b.textContent) }; })()`);
        assert.ok(strip.text.includes(`/Users/me/Coral/${B}`) && /index\.html/.test(strip.text), 'the strip names the team folder and says what to open: ' + JSON.stringify(strip));
        assert.deepEqual(strip.buttons, ['Copy path', 'Download all (zip)']);
        await ev(`[...document.querySelectorAll('#team-panel-artifacts .team-files-strip button')].find(b => b.textContent === 'Copy path').click(); true`);
        await waitFor(`window.__copied.length === 1`, 'the path is copied', 5000);
        assert.equal(await ev('window.__copied[0]'), `/Users/me/Coral/${B}`);
        await ev(`[...document.querySelectorAll('#team-panel-artifacts .team-files-strip button')].find(b => b.textContent.startsWith('Download all')).click(); true`);
        await waitFor(`window.__saved.length === 1`, 'the zip is saved', 10000);
        const saved = await ev('window.__saved[0]');
        assert.equal(saved.name, `${B}-files.zip`);
        const zip = path.join(os.tmpdir(), `${B}.zip`); fs.writeFileSync(zip, Buffer.from(saved.b64, 'base64'));
        const listing = JSON.parse(execFileSync('python3', ['-I', '-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n: z.read(n).decode() for n in z.namelist()}))', zip]).toString());
        fs.rmSync(zip, { force: true });
        assert.deepEqual(Object.keys(listing).sort(), ['README.md', 'app.js', 'index.html'], 'the zip holds the three files');
        assert.equal(listing['index.html'], '<h1>Flashcards</h1><script src="app.js"></script>', 'whole and unchanged');

        console.log('superseded says what it means');
        assert.equal((await api('PUT', `/api/board/${B}/artifacts/${hIndex}/tags`, { tags: ['superseded'] })).status, 200);
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
        await waitFor(`!!document.querySelector('#team-panel-artifacts .artifact-tag')`, 'the chip', 10000);
        const chip = await ev(`(() => { const c = [...document.querySelectorAll('#team-panel-artifacts .artifact-tag')].find(x => x.textContent === 'superseded'); return c ? { title: c.title, d: c.getAttribute('aria-description') } : null; })()`);
        assert.ok(chip && /newer version of this file replaced it/.test(chip.title) && chip.d === chip.title, 'the chip says what replaced the file: ' + JSON.stringify(chip));
        console.log('PASS the Artifacts tab shows the team folder with Copy path, Download all as a zip, and what superseded means');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
