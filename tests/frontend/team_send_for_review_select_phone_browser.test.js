// Select a file with the lead button of its mail row on a 390 px phone and use the selection bar's Send for review / Remove from review (#13387, UI Accessibility's finding on #13152: this phone path had no suite): the bar offers the
// action as a 44 px target, one question covers the two selected files, the server keeps the tag, the rows are in Needs you after the send and out of it after Remove from review. Real stored files of a real board on the
// isolated dev server (needs the review routes, #13217).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'srps-' + Date.now().toString(36);
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

        console.log('1. Tap the lead button of two rows: the selection bar offers Send for review as a 44 px target');
        const pick = name => ev(`(() => { const b = [...document.querySelectorAll('#team-panel-artifacts [data-artifact-id]')].find(x => (x.querySelector('.dt-mail-title') || x).textContent.trim().startsWith(${JSON.stringify(name)})); const lead = b && b.closest('tr').querySelector('button.dt-mail-lead'); if (!lead) return 'no lead button for ' + ${JSON.stringify(name)}; lead.click(); return 'ok'; })()`);
        for (const n of ['plan.txt', 'draft.txt']) assert.equal(await pick(n), 'ok', n);
        const bar = text => `[...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].filter(b => b.getClientRects().length && b.textContent.trim() === ${JSON.stringify(text)})`;
        await waitFor(`${bar('Send for review')}.length === 1`, 'Send for review in the selection bar', 8000);
        const h = await ev(`Math.round(${bar('Send for review')}[0].getBoundingClientRect().height)`);
        assert.ok(h >= 43.5, 'the bar action is a 44 px touch target: ' + h);
        assert.equal(await ev(`${bar('Remove from review')}.length`), 0, 'files that are not for review do not offer Remove');
        await shot('select_review_phone_bar');
        console.log('   ✓');

        console.log('2. Send: one question for both files, the tags are kept, both rows are in Needs you');
        await ev(`${bar('Send for review')}[0].click(); true`);
        await waitFor(`!!document.querySelector('dialog.send-review-dialog[open] .send-review-go')`, 'the question dialog', 8000);
        assert.ok(/2 files/.test(await ev(`document.querySelector('dialog.send-review-dialog[open] h2').textContent`)), 'the dialog says two files');
        await ev(`document.querySelector('dialog.send-review-dialog[open] .send-review-go').click(); true`);
        await until(files[0], true, 'plan.txt is for review'); await until(files[1], true, 'draft.txt is for review');
        const needs = names => ev(`(async () => { const r = await fetch('/api/board/${B}/artifacts?tag=for%20review&limit=50'); const j = await r.json(); return (j.artifacts || []).filter(a => a.tags && a.tags.includes('for review')).map(a => a.name).sort(); })()`);
        assert.deepEqual(await needs(), ['draft.txt', 'plan.txt'], 'both files are in the for-review list that Needs you reads');
        await shot('select_review_phone_sent');
        console.log('   ✓');

        console.log('3. Select the two again: Remove from review is offered (not Send), and they leave');
        await waitFor(`!document.querySelector('dialog.send-review-dialog')`, 'the dialog closed', 4000);
        await ev(`document.querySelector('#team-panel-artifacts .dt-bar-clear, #team-panel-artifacts .dt-bar-close')?.click(); true`);
        const sel = await ev(`document.querySelectorAll('#team-panel-artifacts tr.dt-selected').length`);
        if (sel < 2) for (const n of ['plan.txt', 'draft.txt']) await pick(n);
        await waitFor(`${bar('Remove from review')}.length === 1`, 'Remove from review in the selection bar', 8000);
        assert.equal(await ev(`${bar('Send for review')}.length`), 0, 'files that are for review do not offer Send');
        await ev(`${bar('Remove from review')}[0].click(); true`);
        await until(files[0], false, 'plan.txt is out of review'); await until(files[1], false, 'draft.txt is out of review');
        assert.deepEqual(await needs(), [], 'both files left the for-review list');
        await shot('select_review_phone_removed');
        console.log('   ✓');
        console.log('PASS send for review by selection on a phone: the bar action is a 44 px target, one question for two files, in and out of Needs you');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
