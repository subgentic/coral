// Artifact tags on the team's Artifacts tab (#8594, Goal #61, UI/UX's spec 7): the sheet has the tags as outlined chips with an x each and a "+ Tag" button (the starter set, the team's own tags and a box); a row says at
// most two tags, then +N; the filter menu has a Tag select with counts, and a "For review N" pill sits in the toolbar; the selection bar tags or untags every selected file. Real stored files uploaded by a stood-in
// terminal session of a real board on the isolated dev server (removed again).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'at-' + Date.now().toString(36);
    const api = (method, path, body, headers) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const rowNames = () => ev(`[...document.querySelectorAll('#team-panel-artifacts [data-artifact-id]')].map(b => b.textContent)`);
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Tags QA' });
        sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name; assert.ok(sid, JSON.stringify(launch));
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Tags QA', job_title: 'Backend Dev', session_name: sname })).status < 300);
        const files = [];
        for (const n of ['plan.txt', 'draft.txt', 'log.txt']) {
            const up = await api('POST', `/api/agent/artifacts?session_id=${sid}`, 'content of ' + n + ' ' + Date.now(), { 'X-Artifact-Name': n, 'X-Artifact-Media-Type': 'text/plain' });
            assert.equal(up.status, 201, JSON.stringify(up)); files.push(/[a-f0-9]{64}/.exec(up.body.uri)[0]);
        }
        const tagsOf = async hex => (await api('GET', `/api/board/${B}/artifacts?limit=50`)).body.artifacts.find(a => a.id === hex || (a.uri || '').includes(hex))?.tags || [];
        await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 3`, 'the three files', 15000);

        console.log('1. No tags to begin with: no pill, no chips');
        assert.equal(await ev(`document.querySelectorAll('#team-panel-artifacts .artifact-tag').length`), 0);
        assert.equal(await ev(`!!document.querySelector('#team-panel-artifacts .team-tb-pills')`), false, 'no For review pill while the team has no such tag');
        console.log('   ✓');

        console.log('2. The sheet: + Tag offers the starter set; a tag is added and removed');
        await ev(`[...document.querySelectorAll('#team-panel-artifacts [data-artifact-id]')].find(b => b.textContent === 'plan.txt').click(); true`);
        await waitFor(`!!document.querySelector('.detail-head .artifact-tag-add')`, '+ Tag in the sheet', 10000);
        await ev(`document.querySelector('.detail-head .artifact-tag-add').click(); true`);
        const offers = await ev(`[...document.querySelectorAll('.detail-head .artifact-tag-offer')].map(b => b.textContent)`);
        assert.deepEqual(offers, ['for review', 'internal', 'final', 'draft']);
        await shot('artifact-tags-sheet-offer');
        await ev(`[...document.querySelectorAll('.detail-head .artifact-tag-offer')].find(b => b.textContent === 'for review').click(); true`);
        await waitFor(`[...document.querySelectorAll('.detail-head .artifact-tag-list .artifact-tag')].some(t => t.textContent.startsWith('for review'))`, 'the chip', 8000);
        assert.deepEqual(await tagsOf(files[0]), ['for review'], 'the server kept it');
        await ev(`document.querySelector('.detail-head .artifact-tag-add').click(); const i = document.querySelector('.detail-head .artifact-tag-input'); i.value = '  Needs  QA '; i.form.requestSubmit(); true`);
        await waitFor(`[...document.querySelectorAll('.detail-head .artifact-tag-list .artifact-tag')].some(t => t.textContent.startsWith('needs qa'))`, 'a typed tag, normalised', 8000);
        assert.deepEqual(await tagsOf(files[0]), ['for review', 'needs qa']);
        await ev(`document.querySelector('.detail-head [aria-label="Remove tag needs qa"]').click(); true`);
        await waitFor(`![...document.querySelectorAll('.detail-head .artifact-tag-list .artifact-tag')].some(t => t.textContent.startsWith('needs qa'))`, 'the chip is gone', 8000);
        assert.deepEqual(await tagsOf(files[0]), ['for review']);
        console.log('   ✓');

        console.log('3. The row says its tags, and the For review pill counts them');
        await waitFor(`[...document.querySelectorAll('#team-panel-artifacts .artifact-tags-row')].some(r => r.textContent === 'for review')`, 'the row chip', 8000);
        await waitFor(`!!document.querySelector('#team-panel-artifacts .team-tb-pills') && /For review 1/.test(document.querySelector('#team-panel-artifacts .team-tb-pills').textContent)`, 'the pill', 8000);
        await shot('artifact-tags-row-and-pill');
        console.log('   ✓');

        console.log('4. The pill and the Tag filter narrow the list');
        await ev(`document.querySelector('#team-panel-artifacts .team-tb-pills [data-filter="review"]').click(); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 1`, 'only the tagged file', 8000);
        assert.deepEqual(await rowNames(), ['plan.txt']);
        await ev(`document.querySelector('#team-panel-artifacts .team-tb-pills [data-filter="all"]').click(); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 3`, 'all again', 8000);
        console.log('   ✓');

        console.log('5. The selection bar tags two files at once, and Untag takes it off');
        await ev(`[...document.querySelectorAll('#team-panel-artifacts tbody tr')].filter(r => /draft\\.txt|log\\.txt/.test(r.textContent)).forEach(r => r.querySelector('input[type=checkbox]').click()); true`);
        await waitFor(`[...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].some(b => b.textContent === 'Tag')`, 'the Tag action', 8000);
        await ev(`[...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].find(b => b.textContent === 'Tag').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-artifacts .dt-bar-choice')`, 'the tag choice', 5000);
        await ev(`const c = document.querySelector('#team-panel-artifacts .dt-bar-choice'); c.value = 'internal'; document.querySelector('#team-panel-artifacts .dt-bar-apply').click(); true`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts .artifact-tags-row').length === 3`, 'three rows tagged', 10000);
        assert.deepEqual(await tagsOf(files[1]), ['internal']); assert.deepEqual(await tagsOf(files[2]), ['internal']);
        await shot('artifact-tags-bulk');
        console.log('   ✓');

        console.log('6. The preview\'s head has the same chips and + Tag');
        await ev(`import((window.__coralStatic || '/static/') + 'preview_pane.js').then(m => m.openArtifactTab('coral://artifacts/${files[0]}', { filename: 'plan.txt', mediaType: 'text/plain', tagging: { project: ${JSON.stringify(B)}, tags: ['for review'], editable: true, offer: () => [], onChange: () => {} } })).then(() => true)`);
        await waitFor(`!!document.querySelector('#preview-toolbar .artifact-tag-add')`, '+ Tag in the preview head', 10000);
        assert.equal(await ev(`[...document.querySelectorAll('#preview-toolbar .artifact-tag-list .artifact-tag')].map(t => t.firstChild.textContent).join()`), 'for review');
        await ev(`document.querySelector('#preview-toolbar .artifact-tag-add').click(); [...document.querySelectorAll('#preview-toolbar .artifact-tag-offer')].find(b => b.textContent === 'final').click(); true`);
        await waitFor(`[...document.querySelectorAll('#preview-toolbar .artifact-tag-list .artifact-tag')].some(t => t.textContent.startsWith('final'))`, 'final added from the preview', 8000);
        assert.deepEqual(await tagsOf(files[0]), ['final', 'for review'], 'the server keeps a file\'s tags in alphabetical order');
        await shot('artifact-tags-preview');
        console.log('   ✓');

        console.log('PASS artifact tags: chips and + Tag in the sheet, row chips, the For review pill and Tag filter, Tag and Untag in the selection bar');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
