// #13152 (the operator: 'I'd like to be able to move artifacts to In Review'): the Artifacts tab and the file viewer have a Send for review action that puts a file in Needs you, and Remove from review as its
// reverse. The server's route is a separate task (PUT and DELETE /api/board/<team>/artifacts/<id>/review, the approved contract), so this suite stubs that route in the page and checks what the PAGE does: a file's
// sheet offers Send for review, which asks the one optional question (a dialog, Enter sends, Cancel sends nothing) and then calls PUT with {question}; the selection bar's Send for review does the same for every
// selected file in one question; a file the stub says is for review offers Remove from review (DELETE); the viewer's ⋯ menu has the same two. Real stored files of a real board on the isolated dev server.
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
    const calls = () => ev(`window.__reviewCalls.slice()`);
    const btn = text => `[...document.querySelectorAll('button, [role=menuitem]')].filter(b => b.getClientRects().length && b.textContent.trim() === ${JSON.stringify(text)})`;
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Review QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Review QA', job_title: 'Backend Dev', session_name: sname })).status < 300);
        const files = [];
        for (const n of ['plan.txt', 'draft.txt', 'log.txt']) {
            const up = await api('POST', `/api/agent/artifacts?session_id=${sid}`, 'content of ' + n + ' ' + Date.now(), { 'X-Artifact-Name': n, 'X-Artifact-Media-Type': 'text/plain' });
            assert.equal(up.status, 201, JSON.stringify(up)); files.push(/[a-f0-9]{64}/.exec(up.body.uri)[0]);
        }
        // the review route, as a page stub: records the calls, answers as the contract says
        await ev(`(() => { window.__reviewCalls = []; const real = window.fetch;
            window.fetch = (input, init = {}) => { const u = new URL(String(input && input.url ? input.url : input), location.origin), m = /^\\/api\\/board\\/([^/]+)\\/artifacts\\/([a-f0-9]{64})\\/review$/.exec(u.pathname);
                if (m) { const method = (init.method || 'GET').toUpperCase(), body = init.body ? JSON.parse(init.body) : null; window.__reviewCalls.push({ method, project: m[1], id: m[2], body });
                    return Promise.resolve(new Response(JSON.stringify(method === 'PUT' ? { id: m[2], tags: ['for review'], question: (body && body.question) || '' } : { id: m[2], tags: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return real(input, init); }; return true; })()`);
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 3`, 'the three files', 15000);

        console.log('1. A file\'s sheet offers Send for review; Cancel in the question sends nothing');
        await ev(`[...document.querySelectorAll('#team-panel-artifacts [data-artifact-id]')].find(b => b.textContent === 'plan.txt').click(); true`);
        await waitFor(`${btn('Send for review')}.length > 0`, 'Send for review in the sheet', 10000);
        assert.equal((await ev(`${btn('Remove from review')}.length`)), 0, 'a file that is not for review does not offer Remove');
        await ev(`${btn('Send for review')}[0].click(); true`);
        await waitFor(`!!document.querySelector('dialog.send-review-dialog[open] input')`, 'the question dialog', 8000);
        const dlg = await ev(`(() => { const d = document.querySelector('dialog.send-review-dialog[open]'), i = d.querySelector('input'); return { title: d.querySelector('h2').textContent, label: d.querySelector('label').textContent, labelled: d.getAttribute('aria-labelledby') === d.querySelector('h2').id && d.querySelector('label').htmlFor === i.id, focused: document.activeElement === i, max: i.maxLength, described: !!document.getElementById(i.getAttribute('aria-describedby')) }; })()`);
        assert.ok(/plan\.txt/.test(dlg.title) && /optional/.test(dlg.label) && dlg.labelled && dlg.focused && dlg.max === 140 && dlg.described, 'the dialog names the file, says the question is optional, is labelled and focused: ' + JSON.stringify(dlg));
        await shot('send_for_review_dialog');
        await ev(`[...document.querySelectorAll('dialog.send-review-dialog[open] button')].find(b => b.textContent === 'Cancel').click(); true`);
        await waitFor(`!document.querySelector('dialog.send-review-dialog')`, 'the dialog closed', 4000);
        assert.deepEqual(await calls(), [], 'Cancel sends nothing');
        console.log('   ✓');

        console.log('2. Send with a question (Enter in the box): one PUT with the cleaned question');
        await ev(`${btn('Send for review')}[0].click(); true`);
        await waitFor(`!!document.querySelector('dialog.send-review-dialog[open] input')`, 'the question dialog again', 8000);
        await ev(`(() => { const i = document.querySelector('dialog.send-review-dialog[open] input'); i.value = '  Approve   this  plan?  '; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
        await waitFor(`window.__reviewCalls.length === 1`, 'the PUT', 8000);
        const c1 = (await calls())[0];
        assert.deepEqual(c1, { method: 'PUT', project: B, id: files[0], body: { question: 'Approve this plan?' } }, JSON.stringify(c1));
        console.log('   ✓');

        console.log('3. The selection bar sends two files with one question; an empty question is allowed');
        await ev(`window.__reviewCalls.length = 0; [...document.querySelectorAll('#team-panel-artifacts tbody tr')].filter(r => /draft\\.txt|log\\.txt/.test(r.textContent)).forEach(r => r.querySelector('input[type=checkbox]').click()); true`);
        await waitFor(`[...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].some(b => b.textContent === 'Send for review')`, 'the Send for review bar action', 8000);
        await ev(`[...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].find(b => b.textContent === 'Send for review').click(); true`);
        await waitFor(`!!document.querySelector('dialog.send-review-dialog[open] .send-review-go')`, 'the question dialog for two files', 8000);
        assert.ok(/2 files/.test(await ev(`document.querySelector('dialog.send-review-dialog[open] h2').textContent`)), 'the dialog says two files');
        await ev(`document.querySelector('dialog.send-review-dialog[open] .send-review-go').click(); true`);
        await waitFor(`window.__reviewCalls.length === 2`, 'two PUTs', 8000);
        const c2 = (await calls()).map(c => `${c.method} ${c.id} ${JSON.stringify(c.body)}`).sort();
        assert.deepEqual(c2, [`PUT ${files[1]} {"question":""}`, `PUT ${files[2]} {"question":""}`].sort(), JSON.stringify(c2));
        console.log('   ✓');

        console.log('4. The viewer\'s ⋯ menu has Send for review for a file not in review');
        await ev(`window.__reviewCalls.length = 0; import((window.__coralStatic || '/static/') + 'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(files[0])}, { filename: 'plan.txt', mediaType: 'text/plain', board: ${JSON.stringify(B)} })); true`);
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-review-send:not([hidden])')`, 'the viewer menu item', 10000);
        const item = await ev(`(() => { const b = document.querySelector('#artifact-viewer .artifact-review-send'); return { text: b.textContent, role: b.getAttribute('role'), inMenu: !!b.closest('.artifact-viewer-menu') }; })()`);
        assert.deepEqual(item, { text: 'Send for review', role: 'menuitem', inMenu: true }, JSON.stringify(item));
        await shot('send_for_review_viewer_menu');
        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
        console.log('   ✓');
        console.log('PASS send for review: the sheet, the selection bar and the viewer menu ask the optional question and call the review route');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
