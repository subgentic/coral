// Artifact tags on the team's Artifacts tab (#8594, Goal #61, UI/UX's spec 7): the sheet has the tags as outlined chips with an x each and a "Add tag" button (the starter set, the team's own tags and a box); a row says at
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
    const pick = async (id, value) => { await ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); };
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

        console.log('2. The sheet: Add tag offers the starter set; a tag is added and removed');
        await ev(`[...document.querySelectorAll('#team-panel-artifacts [data-artifact-id]')].find(b => b.textContent === 'plan.txt').click(); true`);
        await waitFor(`!!document.querySelector('.detail-head .artifact-tag-add')`, 'Add tag in the sheet', 10000);
        const look = await ev(`(() => { const b = document.querySelector('.detail-head .artifact-tag-add'), c = getComputedStyle(b); return { text: b.textContent, cls: b.className, border: c.borderStyle, family: ['btn', 'btn-quiet', 'btn-small'].every(k => b.classList.contains(k)) }; })()`);
        assert.ok(look.family && look.text === 'Add tag' && look.border !== 'dashed', 'Add tag is a quiet small button of the family, not a dashed outline: ' + JSON.stringify(look));
        await ev(`document.querySelector('.detail-head .artifact-tag-add').click(); true`);
        const offers = await ev(`[...document.querySelectorAll('.detail-head .artifact-tag-offer')].map(b => b.textContent)`);
        assert.deepEqual(offers, ['for review', 'internal', 'final', 'draft']);
        await shot('artifact-tags-sheet-offer');
        await ev(`[...document.querySelectorAll('.detail-head .artifact-tag-offer')].find(b => b.textContent === 'for review').click(); true`);
        await waitFor(`[...document.querySelectorAll('.detail-head .artifact-tag-list .artifact-tag')].some(t => t.textContent.startsWith('for review'))`, 'the chip', 8000);
        assert.deepEqual(await tagsOf(files[0]), ['for review'], 'the server kept it');
        await ev(`(() => { document.querySelector('.detail-head .artifact-tag-add').click(); const i = document.querySelector('.detail-head .artifact-tag-input'); i.value = '  Needs  QA '; i.form.requestSubmit(); return true; })()`);
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
        await ev(`(() => { const c = document.querySelector('#team-panel-artifacts .dt-bar-choice'); c.value = 'internal'; document.querySelector('#team-panel-artifacts .dt-bar-apply').click(); return true; })()`);
        await waitFor(`document.querySelectorAll('#team-panel-artifacts .artifact-tags-row').length === 3`, 'three rows tagged', 10000);
        assert.deepEqual(await tagsOf(files[1]), ['internal']); assert.deepEqual(await tagsOf(files[2]), ['internal']);
        await shot('artifact-tags-bulk');
        console.log('   ✓');

        console.log('6. The preview\'s head has the same chips and Add tag');
        await ev(`import((window.__coralStatic || '/static/') + 'preview_pane.js').then(m => m.openArtifactTab('coral://artifacts/${files[0]}', { filename: 'plan.txt', mediaType: 'text/plain', tagging: { project: ${JSON.stringify(B)}, tags: ['for review'], editable: true, offer: () => [], onChange: () => {} } })).then(() => true)`);
        await waitFor(`!!document.querySelector('#preview-toolbar .artifact-tag-add')`, 'Add tag in the preview head', 10000);
        assert.equal(await ev(`[...document.querySelectorAll('#preview-toolbar .artifact-tag-list .artifact-tag')].map(t => t.firstChild.textContent).join()`), 'for review');
        await ev(`document.querySelector('#preview-toolbar .artifact-tag-add').click(); [...document.querySelectorAll('#preview-toolbar .artifact-tag-offer')].find(b => b.textContent === 'final').click(); true`);
        await waitFor(`[...document.querySelectorAll('#preview-toolbar .artifact-tag-list .artifact-tag')].some(t => t.textContent.startsWith('final'))`, 'final added from the preview', 8000);
        assert.deepEqual(await tagsOf(files[0]), ['final', 'for review'], 'the server keeps a file\'s tags in alphabetical order');
        await shot('artifact-tags-preview');
        console.log('   ✓');

        // ── the edges (#8594 review): set the tags through the route, then read the page ──────────────────────────────────
        const put = async (hex, tags) => assert.equal((await api('PUT', `/api/board/${B}/artifacts/${hex}/tags`, { tags })).status, 200);
        const reload = async () => { await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks' }); true`); await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'artifacts' }); true`); await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 3`, 'the list again', 15000); };
        const sheet = async name => { await ev(`[...document.querySelectorAll('#team-panel-artifacts [data-artifact-id]')].find(b => b.textContent === ${JSON.stringify(name)}).click(); true`); await waitFor(`document.querySelector('.detail-head h2')?.textContent === ${JSON.stringify(name)}`, `the sheet of ${name}`, 10000); };
        const rowOf = name => `[...document.querySelectorAll('#team-panel-artifacts tbody tr')].find(r => r.querySelector('[data-artifact-id]')?.textContent === ${JSON.stringify(name)})`;
        const select = async names => { await ev(`(() => { ${JSON.stringify(names)}.forEach(n => { const r = [...document.querySelectorAll('#team-panel-artifacts tbody tr')].find(x => x.querySelector('[data-artifact-id]')?.textContent === n); const c = r.querySelector('input[type=checkbox]'); if (!c.checked) c.click(); }); return true; })()`); };
        await put(files[0], ['final', 'for review']); await put(files[1], ['t1', 't2', 't3', 't4', 't5']); await put(files[2], ['alpha', 'beta', 'gamma']);
        await reload();

        console.log('7. A row says two tags then +N; the title and the row\'s name list them all');
        const row = await ev(`(() => { const r = ${rowOf('log.txt')}, w = r.querySelector('.artifact-tags-row'); return { chips: [...w.querySelectorAll('.artifact-tag:not(.artifact-tag-more)')].map(c => c.textContent), more: w.querySelector('.artifact-tag-more')?.textContent, title: w.title, name: r.querySelector('input[type=checkbox]').getAttribute('aria-label') }; })()`);
        assert.deepEqual(row, { chips: ['alpha', 'beta'], more: '+1', title: 'Tags: alpha, beta, gamma', name: 'Select log.txt, tags: alpha, beta, gamma' });
        const two = await ev(`(() => { const w = ${rowOf('plan.txt')}.querySelector('.artifact-tags-row'); return { n: w.querySelectorAll('.artifact-tag').length, more: !!w.querySelector('.artifact-tag-more') }; })()`);
        assert.deepEqual(two, { n: 2, more: false }, 'two tags: no +N');
        console.log('   ✓');

        console.log('8. Five tags: no Add tag; the box offers the starters, then the team\'s tags with counts; a refused word is said and the box stays');
        await sheet('draft.txt');
        assert.equal(await ev(`document.querySelectorAll('.detail-head .artifact-tag-list .artifact-tag').length`), 5);
        assert.equal(await ev(`document.querySelector('.detail-head .artifact-tag-add').hidden`), true, 'five is the most: no Add tag');
        await sheet('log.txt');
        await ev(`document.querySelector('.detail-head .artifact-tag-add').click(); true`);
        const offers2 = await ev(`[...document.querySelectorAll('.detail-head .artifact-tag-offer')].map(b => b.textContent)`);
        assert.deepEqual(offers2.slice(0, 4), ['for review', 'internal', 'final', 'draft'], 'the starter set first');
        assert.ok(offers2.includes('t1 (1)') && offers2.includes('t5 (1)'), 'then the team\'s tags with their counts: ' + JSON.stringify(offers2));
        assert.ok(!offers2.some(t => /^(alpha|beta|gamma)/.test(t)), 'not the ones the file has');
        await ev(`(() => { const i = document.querySelector('.detail-head .artifact-tag-input'); i.value = 'bad_tag'; i.form.requestSubmit(); return true; })()`);
        await waitFor(`/1 to 24 letters, digits, spaces or hyphens/.test(document.querySelector('.detail-head .artifact-tag-status').textContent)`, 'the refusal in words', 5000);
        assert.equal(await ev(`document.querySelector('.detail-head .artifact-tag-box').hidden`), false, 'the box stays open');
        assert.deepEqual(await tagsOf(files[2]), ['alpha', 'beta', 'gamma'], 'nothing was changed');
        console.log('   ✓');

        console.log('9. The Tag select narrows the list, with the route\'s counts');
        await ev(`document.querySelector('#team-panel-artifacts .list-bar-filter-btn, #team-panel-artifacts button[aria-label*="Filters" i], #team-panel-artifacts .list-bar-icon')?.click(); true`);
        await waitFor(`!!document.getElementById('ta-tag') && document.getElementById('ta-tag').offsetParent !== null`, 'the Tag select', 5000);
        assert.ok(await ev(`[...document.getElementById('ta-tag').options].some(o => o.textContent === 'alpha (1)')`), 'counts from tag_counts');
        await pick('ta-tag', 'alpha');
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 1`, 'only the tagged file', 8000);
        assert.deepEqual(await rowNames(), ['log.txt']);
        assert.ok(await ev(`[...document.querySelectorAll('#team-panel-artifacts [class*=chip]')].some(c => c.textContent.includes('Tag: alpha'))`), 'its chip');
        await pick('ta-tag', '');
        await waitFor(`document.querySelectorAll('#team-panel-artifacts [data-artifact-id]').length === 3`, 'all again', 8000);
        console.log('   ✓');

        console.log('10. Untag takes the tag off the selected files only; Tag leaves a file with five alone and says so');
        await ev(`(() => { window.__puts = []; if (!window.__fetchWrapped) { const real = window.fetch; window.__fetchWrapped = true; window.fetch = (u, o) => { if (o && o.method === 'PUT') window.__puts.push(String(u && u.url || u)); return real(u, o); }; } return true; })()`); // which files a bulk action asks the server to change
        await select(['plan.txt', 'log.txt']);
        await waitFor(`[...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].some(b => b.textContent === 'Untag')`, 'the Untag action', 8000);
        await ev(`[...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].find(b => b.textContent === 'Untag').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-artifacts .dt-bar-choice')`, 'the choice', 5000);
        await ev(`document.querySelector('#team-panel-artifacts .dt-bar-choice').value = 'for review'; document.querySelector('#team-panel-artifacts .dt-bar-apply').click(); true`);
        await waitFor(`!${rowOf('plan.txt')}.querySelector('.artifact-tags-row')?.textContent.includes('for review')`, 'plan.txt untagged', 10000);
        assert.deepEqual(await tagsOf(files[0]), ['final'], 'the tag is off');
        assert.deepEqual(await tagsOf(files[2]), ['alpha', 'beta', 'gamma'], 'a file without it is left as it was');
        assert.deepEqual(await ev('window.__puts.map(u => /[a-f0-9]{64}/.exec(u)[0])'), [files[0]], 'only the file that has the tag is changed: the other is not asked about');
        await ev(`document.querySelector('#team-panel-artifacts .dt-bar .dt-bar-clear, #team-panel-artifacts .dt-bar [class*=clear]')?.click(); true`);
        await reload();
        await ev('window.__puts = []; true');
        await select(['draft.txt', 'log.txt']);
        await waitFor(`[...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].some(b => b.textContent === 'Tag')`, 'the Tag action', 8000);
        await ev(`[...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].find(b => b.textContent === 'Tag').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-artifacts .dt-bar-choice')`, 'the choice', 5000);
        await ev(`(() => { const c = document.querySelector('#team-panel-artifacts .dt-bar-choice'); c.value = 'draft'; document.querySelector('#team-panel-artifacts .dt-bar-apply').click(); return true; })()`);
        await waitFor(`/could not be changed/.test(document.body.textContent)`, 'the toast says one could not be changed', 10000);
        assert.deepEqual(await tagsOf(files[1]), ['t1', 't2', 't3', 't4', 't5'], 'five is the most: left alone');
        assert.ok(!(await ev('window.__puts.map(u => /[a-f0-9]{64}/.exec(u)[0])')).includes(files[1]), 'a file with five tags is not even asked');
        assert.deepEqual(await tagsOf(files[2]), ['alpha', 'beta', 'draft', 'gamma'], 'the other got it');
        console.log('   ✓');

        console.log('11. A tag changed in the sheet moves the For review pill without another read');
        await reload();
        assert.equal(await ev(`!!document.querySelector('#team-panel-artifacts .team-tb-pills')`), false, 'nobody has For review: no pill');
        await sheet('plan.txt');
        await ev(`document.querySelector('.detail-head .artifact-tag-add').click(); [...document.querySelectorAll('.detail-head .artifact-tag-offer')].find(b => b.textContent === 'for review').click(); true`);
        await waitFor(`/For review 1/.test(document.querySelector('#team-panel-artifacts .team-tb-pills')?.textContent || '')`, 'the pill says 1', 8000);
        await ev(`document.querySelector('.detail-head [aria-label="Remove tag for review"]').click(); true`);
        await waitFor(`!document.querySelector('#team-panel-artifacts .team-tb-pills')`, 'the pill is gone at 0', 8000);
        console.log('   ✓');

        console.log('12. A viewer who cannot change tags sees the chips and no controls');
        await ev(`document.body.classList.add('popout-mode'); true`); // local() is false: the Operator's own Coral only
        await put(files[0], ['final', 'for review']);
        await reload();
        await sheet('plan.txt');
        assert.equal(await ev(`document.querySelectorAll('.detail-head .artifact-tag-list .artifact-tag').length`), 2, 'the chips are there');
        assert.equal(await ev(`document.querySelectorAll('.detail-head .artifact-tag-remove').length`), 0, 'no x');
        assert.equal(await ev(`document.querySelector('.detail-head .artifact-tag-add').hidden`), true, 'no Add tag');
        await select(['plan.txt']);
        await waitFor(`!![...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].length`, 'the selection bar', 8000);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#team-panel-artifacts .dt-bar-action')].map(b => b.textContent).filter(t => /^(Tag|Untag)$/.test(t))`), [], 'no Tag or Untag');
        await ev(`document.body.classList.remove('popout-mode'); true`);
        console.log('   ✓');

        console.log('13. On a phone every control of the editor is a 44 px target');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await reload();
        await ev(`(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); const clear = [...document.querySelectorAll('#team-panel-artifacts .dt-bar button')].find(b => b.textContent === 'Clear'); clear?.click(); const k = document.getElementById('ta-kept'); if (k && k.offsetParent !== null) document.querySelector('#team-panel-artifacts .list-bar-filter-btn, #team-panel-artifacts button[aria-label*="Filters" i], #team-panel-artifacts .list-bar-icon')?.click(); return true; })()`); // a clean list for the shot: no toast, nothing selected, the filter panel shut
        await shot('artifact-tags-row-390');
        await sheet('log.txt');
        await ev(`document.querySelector('.detail-head .artifact-tag-add').click(); true`);
        await waitFor(`!!document.querySelector('.detail-head .artifact-tag-offer')`, 'the box', 5000);
        const sizes = await ev(`(() => { const h = sel => Math.round(document.querySelector(sel).getBoundingClientRect().height), x = document.querySelector('.detail-head .artifact-tag-remove'), pe = x && getComputedStyle(x, '::after'); return { add: h('.detail-head .artifact-tag-add'), offer: h('.detail-head .artifact-tag-offer'), input: h('.detail-head .artifact-tag-input'), go: h('.detail-head .artifact-tag-form .btn'), x: x ? Math.round(parseFloat(pe.height)) : 0 }; })()`);
        for (const k of ['add', 'offer', 'input', 'go']) assert.ok(sizes[k] >= 44, `${k} is ${sizes[k]} px: ` + JSON.stringify(sizes));
        assert.ok(sizes.x >= 44, 'the x inset target: ' + JSON.stringify(sizes));
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
        await shot('artifact-tags-sheet-box-390');
        console.log('   ✓');

        console.log('PASS artifact tags: chips and Add tag in the sheet, row chips, the For review pill and Tag filter, Tag and Untag in the selection bar');
    } finally {
        if (sid) await ev(`fetch('/api/sessions/live/${encodeURIComponent(sname || '')}/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(sid)} }) }).then(() => true)`).catch(() => {});
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
