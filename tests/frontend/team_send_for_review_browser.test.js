// #13152 (the operator: 'I'd like to be able to move artifacts to In Review'): the Artifacts tab and the file viewer have a Send for review action that puts a file in Needs you, and Remove from review as its
// reverse, through the owner's route PUT and DELETE /api/board/<team>/artifacts/<id>/review (#13217). A file's sheet offers Send for review, which asks the one optional question (a dialog: Enter sends, Cancel
// sends nothing) and the server keeps the tag; the selection bar's Send for review does the same for every selected file with one question; the row says "for review"; a file that is for review offers Remove from
// review in its sheet and in the viewer's ⋯ menu, and the tag is gone after it. Real stored files of a real board on the isolated dev server (needs the review routes: run on a build with #13217).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'sr-' + Date.now().toString(36);
    const api = (method, path, body, headers) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const btn = text => `[...document.querySelectorAll('button, [role=menuitem]')].filter(b => b.getClientRects().length && b.textContent.trim() === ${JSON.stringify(text)})`;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a poll of the server's own state
    let sid = null, sname = null, files = [];
    const tagsOf = async hex => (await api('GET', `/api/board/${B}/artifacts?limit=50`)).body.artifacts.find(a => a.id === hex || (a.uri || '').includes(hex))?.tags || [];
    const until = async (hex, want, what) => { for (let i = 0; i < 40; i++) { if ((await tagsOf(hex)).includes('for review') === want) return; await sleep(250); /* sleep-ok: a bounded poll of the server's own state, 40 tries */ } assert.fail(`${what}: tags ${JSON.stringify(await tagsOf(hex))}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Review QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Review QA', job_title: 'Backend Dev', session_name: sname })).status < 300);
        for (const n of ['plan.txt', 'draft.txt', 'log.txt']) {
            const up = await api('POST', `/api/agent/artifacts?session_id=${sid}`, 'content of ' + n + ' ' + Date.now(), { 'X-Artifact-Name': n, 'X-Artifact-Media-Type': 'text/plain' });
            assert.equal(up.status, 201, JSON.stringify(up)); files.push(/[a-f0-9]{64}/.exec(up.body.uri)[0]);
        }
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 3`, 'the three files', 15000);
        const openSheet = async name => { await ev(`[...document.querySelectorAll('#team-panel-artifacts [data-artifact-id]')].find(b => b.textContent === ${JSON.stringify(name)}).click(); true`); };

        console.log('1. A file\'s sheet offers Send for review; Cancel in the question sends nothing');
        await openSheet('plan.txt');
        await waitFor(`${btn('Send for review')}.length > 0`, 'Send for review in the sheet', 10000);
        assert.equal((await ev(`${btn('Remove from review')}.length`)), 0, 'a file that is not for review does not offer Remove');
        await ev(`${btn('Send for review')}[0].click(); true`);
        await waitFor(`!!document.querySelector('dialog.send-review-dialog[open] input')`, 'the question dialog', 8000);
        const dlg = await ev(`(() => { const d = document.querySelector('dialog.send-review-dialog[open]'), i = d.querySelector('input'); return { title: d.querySelector('h2').textContent, label: d.querySelector('label').textContent, labelled: d.getAttribute('aria-labelledby') === d.querySelector('h2').id && d.querySelector('label').htmlFor === i.id, focused: document.activeElement === i, max: i.maxLength, described: !!document.getElementById(i.getAttribute('aria-describedby')) }; })()`);
        assert.ok(/plan\.txt/.test(dlg.title) && /optional/.test(dlg.label) && dlg.labelled && dlg.focused && dlg.max === 140 && dlg.described, 'the dialog names the file, says the question is optional, is labelled and focused: ' + JSON.stringify(dlg));
        const box = await ev(`(() => { const r = document.querySelector('dialog.send-review-dialog[open]').getBoundingClientRect(); return { cx: Math.round((r.left + r.right) / 2), cy: Math.round((r.top + r.bottom) / 2), vw: innerWidth, vh: innerHeight, left: Math.round(r.left), top: Math.round(r.top) }; })()`);
        assert.ok(Math.abs(box.cx - box.vw / 2) <= 2 && Math.abs(box.cy - box.vh / 2) <= 2 && box.left > 0 && box.top > 0, 'the dialog is centred in the window, not in its top-left corner: ' + JSON.stringify(box));
        await shot('send_for_review_dialog');
        await ev(`[...document.querySelectorAll('dialog.send-review-dialog[open] button')].find(b => b.textContent === 'Cancel').click(); true`);
        await waitFor(`!document.querySelector('dialog.send-review-dialog')`, 'the dialog closed', 4000);
        assert.ok(!(await tagsOf(files[0])).includes('for review'), 'Cancel sends nothing');
        console.log('   ✓');

        console.log('2. Send with a question (Enter in the box): the server keeps the tag; the row says so');
        await ev(`${btn('Send for review')}[0].click(); true`);
        await waitFor(`!!document.querySelector('dialog.send-review-dialog[open] input')`, 'the question dialog again', 8000);
        await ev(`(() => { const i = document.querySelector('dialog.send-review-dialog[open] input'); i.value = '  Approve   this  plan?  '; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
        await until(files[0], true, 'plan.txt is for review');
        await waitFor(`[...document.querySelectorAll('#team-panel-artifacts tbody tr')].some(r => /plan\\.txt/.test(r.textContent) && /for review/.test(r.textContent))`, 'the row says for review', 10000);
        await shot('send_for_review_row');
        console.log('   ✓');

        console.log('3. The selection bar sends two files with one question; an empty question is allowed');
        await ev(`[...document.querySelectorAll('#team-panel-artifacts tbody tr')].filter(r => /draft\\.txt|log\\.txt/.test(r.textContent)).forEach(r => r.querySelector('input[type=checkbox]').click()); true`);
        await waitFor(`[...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].some(b => b.textContent === 'Send for review')`, 'the Send for review bar action', 8000);
        await ev(`[...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].find(b => b.textContent === 'Send for review').click(); true`);
        await waitFor(`!!document.querySelector('dialog.send-review-dialog[open] .send-review-go')`, 'the question dialog for two files', 8000);
        assert.ok(/2 files/.test(await ev(`document.querySelector('dialog.send-review-dialog[open] h2').textContent`)), 'the dialog says two files');
        await ev(`document.querySelector('dialog.send-review-dialog[open] .send-review-go').click(); true`);
        await until(files[1], true, 'draft.txt is for review'); await until(files[2], true, 'log.txt is for review');
        console.log('   ✓');

        console.log('4. A file that is for review offers Remove from review in its sheet, and the tag is gone after it');
        await openSheet('draft.txt');
        await waitFor(`${btn('Remove from review')}.length > 0`, 'Remove from review in the sheet', 10000);
        assert.equal((await ev(`${btn('Send for review')}.length`)), 0, 'a file that is for review does not offer Send');
        await ev(`${btn('Remove from review')}[0].click(); true`);
        await until(files[1], false, 'draft.txt is out of review');
        console.log('   ✓');

        console.log('5. The viewer\'s ⋯ menu: Remove from review for a file in review, Send for review once it is out');
        await ev(`import((window.__coralStatic || '/static/') + 'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(files[0])}, { filename: 'plan.txt', mediaType: 'text/plain', board: ${JSON.stringify(B)} })); true`);
        await waitFor(`/Remove from review/.test(document.querySelector('#artifact-viewer .artifact-review-send:not([hidden])')?.textContent || '')`, 'Remove from review in the viewer menu', 10000);
        const item = await ev(`(() => { const b = document.querySelector('#artifact-viewer .artifact-review-send'); return { role: b.getAttribute('role'), inMenu: !!b.closest('.artifact-viewer-menu') }; })()`);
        assert.deepEqual(item, { role: 'menuitem', inMenu: true }, JSON.stringify(item));
        await shot('send_for_review_viewer_menu');
        await ev(`document.querySelector('#artifact-viewer .artifact-review-send').click(); true`);
        await until(files[0], false, 'plan.txt is out of review via the viewer');
        await waitFor(`/Send for review/.test(document.querySelector('#artifact-viewer .artifact-review-send:not([hidden])')?.textContent || '')`, 'the viewer menu offers Send again after the reload', 10000);
        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
        console.log('   ✓');
        console.log('PASS send for review: the sheet, the selection bar and the viewer menu send and remove through the review route');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
