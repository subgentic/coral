// #13152, the phone path (the Hub Lead's finding: team_send_for_review_browser drives 1280 only and its row lookup does not find a phone's rows): on a 390 px touch phone a team's Artifacts rows are mail rows (the open
// button's text holds the title and more), the sheet holds the actions, and Send for review works from it: the question dialog is centred, its buttons are 44 px targets, nothing is wider than the screen, also at 200% text;
// Remove from review is offered once a file is in review; the viewer's ⋯ menu has the same two. Real stored files of a real board on the isolated dev server (needs the review routes, #13217).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'srp-' + Date.now().toString(36);
    const api = (method, path, body, headers) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const btn = text => `[...document.querySelectorAll('button, [role=menuitem]')].filter(b => b.getClientRects().length && b.textContent.trim() === ${JSON.stringify(text)})`;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a poll of the server's own state
    let sid = null, sname = null; const files = [];
    const tagsOf = async hex => (await api('GET', `/api/board/${B}/artifacts?limit=50`)).body.artifacts.find(a => a.id === hex || (a.uri || '').includes(hex))?.tags || [];
    const until = async (hex, want, what) => { for (let i = 0; i < 40; i++) { if ((await tagsOf(hex)).includes('for review') === want) return; await sleep(250); /* sleep-ok: a bounded poll of the server's own state, 40 tries */ } assert.fail(`${what}: tags ${JSON.stringify(await tagsOf(hex))}`); };
    // a phone's row on the team page is a mail row with two buttons: the select/avatar button and the open button (.dt-mail-open, data-artifact-id), whose text holds the title, the uploader and the time; there is no Details control.
    // The open button is the way in: the row is found by its title, and the pane it opens carries the row's actions.
    const openSheet = async name => {
        const found = await ev(`(() => { const b = [...document.querySelectorAll('#team-panel-artifacts [data-artifact-id]')].find(x => (x.querySelector('.dt-mail-title') || x).textContent.trim().startsWith(${JSON.stringify(name)})); if (!b) return 'no row'; b.click(); return 'ok'; })()`);
        assert.equal(found, 'ok', `${name}: ${found}`);
    };
    // an action is looked for in the pane that is open (it may redraw in place after a send), then, if it is not there, in the pane opened again from the row
    const showAction = async (text, name) => {
        const there = await waitFor(`${btn(text)}.length > 0`, `${text} in the open pane`, 3000).then(() => true, () => false);
        if (!there) { await openSheet(name); await waitFor(`${btn(text)}.length > 0`, `${text} after opening ${name} again`, 10000); }
    };
    const dialogBox = () => ev(`(() => { const d = document.querySelector('dialog.send-review-dialog[open]'); if (!d) return null; const r = d.getBoundingClientRect(), small = [...d.querySelectorAll('button')].filter(b => b.getBoundingClientRect().height < 43.5).map(b => b.textContent), i = d.querySelector('input').getBoundingClientRect();
        return { cx: Math.round((r.left + r.right) / 2), cy: Math.round((r.top + r.bottom) / 2), vw: innerWidth, vh: innerHeight, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), small, inputRight: Math.round(i.right), docOver: document.documentElement.scrollWidth - innerWidth }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Review QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Review QA', job_title: 'Backend Dev', session_name: sname })).status < 300);
        for (const n of ['plan.txt', 'draft.txt']) {
            const up = await api('POST', `/api/agent/artifacts?session_id=${sid}`, 'content of ' + n + ' ' + Date.now(), { 'X-Artifact-Name': n, 'X-Artifact-Media-Type': 'text/plain' });
            assert.equal(up.status, 201, JSON.stringify(up)); files.push(/[a-f0-9]{64}/.exec(up.body.uri)[0]);
        }
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 2`, 'the two files on the phone', 15000);

        console.log('1. A phone\'s sheet offers Send for review as a 44 px target; the question dialog is centred, its buttons are 44 px, nothing is wider than the screen');
        await openSheet('plan.txt');
        await showAction('Send for review', 'plan.txt');
        assert.equal((await ev(`${btn('Remove from review')}.length`)), 0, 'a file that is not for review does not offer Remove');
        const target = await ev(`Math.round(${btn('Send for review')}[0].getBoundingClientRect().height)`);
        assert.ok(target >= 43.5, 'Send for review is a 44 px touch target: ' + target);
        await shot('send_for_review_phone_sheet');
        await ev(`${btn('Send for review')}[0].click(); true`);
        await waitFor(`!!document.querySelector('dialog.send-review-dialog[open] input')`, 'the question dialog', 8000);
        for (const size of ['', '32px']) {
            await ev(`document.documentElement.style.fontSize = '${size}'; true`);
            const box = await dialogBox();
            assert.ok(Math.abs(box.cx - box.vw / 2) <= 2 && box.left >= 0 && box.right <= box.vw + 1 && box.top >= 0 && box.bottom <= box.vh + 1, `${size || '100%'}: the dialog is centred and inside the screen: ` + JSON.stringify(box));
            assert.deepEqual(box.small, [], `${size || '100%'}: the dialog's buttons are 44 px targets`);
            assert.ok(box.inputRight <= box.vw && box.docOver <= 0, `${size || '100%'}: nothing is wider than the screen: ` + JSON.stringify(box));
            if (!size) await shot('send_for_review_phone_dialog'); else await shot('send_for_review_phone_dialog_200');
        }
        await ev(`document.documentElement.style.fontSize = ''; [...document.querySelectorAll('dialog.send-review-dialog[open] button')].find(b => b.textContent === 'Cancel').click(); true`);
        await waitFor(`!document.querySelector('dialog.send-review-dialog')`, 'the dialog closed', 4000);
        assert.ok(!(await tagsOf(files[0])).includes('for review'), 'Cancel sends nothing');
        console.log('   ✓');

        console.log('2. Send from the phone\'s sheet: the server keeps the tag, and the sheet then offers Remove from review');
        await ev(`${btn('Send for review')}[0].click(); true`);
        await waitFor(`!!document.querySelector('dialog.send-review-dialog[open] input')`, 'the question dialog again', 8000);
        await ev(`(() => { const i = document.querySelector('dialog.send-review-dialog[open] input'); i.value = 'Approve this plan?'; document.querySelector('dialog.send-review-dialog[open] .send-review-go').click(); return true; })()`);
        await until(files[0], true, 'plan.txt is for review');
        await waitFor(`!document.querySelector('dialog.send-review-dialog')`, 'the dialog closed after sending', 4000);
        await showAction('Remove from review', 'plan.txt');
        assert.equal((await ev(`${btn('Send for review')}.length`)), 0, 'a file that is for review does not offer Send');
        await ev(`${btn('Remove from review')}[0].click(); true`);
        await until(files[0], false, 'plan.txt is out of review');
        console.log('   ✓');

        console.log('3. The viewer\'s ⋯ menu on a phone has Send for review');
        await ev(`import((window.__coralStatic || '/static/') + 'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(files[1])}, { filename: 'draft.txt', mediaType: 'text/plain', board: ${JSON.stringify(B)} })); true`);
        await waitFor(`/Send for review/.test(document.querySelector('#artifact-viewer .artifact-review-send:not([hidden])')?.textContent || '')`, 'Send for review in the viewer menu', 10000);
        const item = await ev(`(() => { const b = document.querySelector('#artifact-viewer .artifact-review-send'); return { role: b.getAttribute('role'), inMenu: !!b.closest('.artifact-viewer-menu') }; })()`);
        assert.deepEqual(item, { role: 'menuitem', inMenu: true }, JSON.stringify(item));
        await shot('send_for_review_phone_viewer');
        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
        console.log('   ✓');
        console.log('PASS send for review on a phone: the sheet, the question dialog (centred, 44 px, also at 200% text) and the viewer menu');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
