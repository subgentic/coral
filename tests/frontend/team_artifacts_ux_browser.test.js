// #4469 (UX's #4456 pass, items 1 to 8 and #4460's NIT; the table is the team page's since #7622): the agent's artifacts table, driven by keys and measured, against stubbed lists.
//  - a row is one control, its name, and holds no icons over the Created time or the name; on a touch phone every control is a 44 px target and nothing is wider than the screen at 200% text
//  - an error is red and an empty list shows its line without a table; "1 artifact"
//  - Delete by keyboard (in the row's sheet): the confirmation, then Yes, and the focus lands on the next row's name (the previous row's when the last one went, Refresh when none is left), never the page
//  - the outcome of a delete is in a live region that is always in the page; Retry leaves the focus on the panel, not the page; a reload keeps the focus while it loads
// Run against an isolated dev server. CORAL_SCREENSHOT_DIR=<dir> saves screenshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');

const HEX = c => c.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the panel rebuilds after a stubbed answer, a layout settles; there is no completion event
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const press = async (key, code, vk) => { const b = { key, code, windowsVirtualKeyCode: vk }; await Input.dispatchKeyEvent({ type: 'keyDown', ...b, ...(key === 'Enter' ? { text: '\r' } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', ...b }); };
    const active = () => ev(`(() => { const a = document.activeElement; if (!a || a === document.body) return { body: true }; const row = a.closest('tbody tr'); return { cls: String(a.className), label: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 40), row: row ? [...row.parentElement.children].indexOf(row) : -1, inModal: !!a.closest('#confirm-modal'), id: a.id }; })()`);
    const team = 'ux-team-' + Date.now();
    const ITEMS = [0, 1, 2].map(i => ({ id: HEX('abc'[i]), name: `report-${i}.txt`, media_type: 'text/plain', size: 1000 + i, task_id: 20 + i, task_title: 'T' + i, created_at: `2026-10-0${i + 1}T10:00:00Z`, uri: 'coral://artifacts/' + HEX('abc'[i]), available: true, source: 'completion', provenance: 'uploaded', produced_by: 'Worker' }));
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch; window.__mode = 'normal'; window.__items = ${JSON.stringify(ITEMS)}; window.__lists = 0; window.__deletes = []; window.__release = null;
            const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = (o.method || 'GET').toUpperCase(); const p = url.pathname;
                if (p.startsWith('/api/board/') && p.endsWith('/artifacts')) { window.__lists++; const body = () => json({ session_id: new URL(String(u), location.origin).searchParams.get('session_id') || undefined, project: decodeURIComponent(p.split('/')[3]), artifacts: window.__mode === 'empty' ? [] : window.__items, has_more: false, truncated: false });
                    if (window.__mode === 'error') return json({}, 500); if (window.__mode === 'deferred') return new Promise(res => { window.__release = () => res(body()); }); return body(); }
                if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
                { const d = /^\\/api\\/artifacts\\/([a-f0-9]{64})$/.exec(p); if (d && m === 'DELETE') { window.__deletes.push(d[1]); window.__items = window.__items.filter(i => !i.uri.endsWith(d[1])); return json({ deleted: true, bytes: 1 }); } }
                if (p.startsWith('/api/')) return json({}); return R(u, o); };
            return true; })()`);
        await ev(`(async () => { const {state} = await import((window.__coralStatic||'/static/')+'state.js'); const files = await import((window.__coralStatic||'/static/')+'changed_files.js');
            state.currentSession = { type: 'live', name: 'ux-ui', session_id: 'ux-a', board_project: ${JSON.stringify(team)} };
            const {showView} = await import((window.__coralStatic||'/static/')+'utils.js'); showView('live-session-view');
            const side = document.getElementById('agentic-state'); side.classList.remove('collapsed'); side.style.width = '680px'; files.initFileSearch(); files.syncFilesViewerSession(); return true; })()`);
        await ev(`localStorage.removeItem('coral-agentic-tab-top'); document.getElementById('agentic-tab-artifacts').click(); true`);
        const ROWS = '#agentic-panel-artifacts-view tbody tr';
        const FOOT = t => `[...document.querySelectorAll('#agentic-detail-pane .detail-foot .btn')].find(b => b.textContent === '${t}')`;
        await waitFor(`document.querySelectorAll('${ROWS}').length === 3`, 'the three rows', 8000);

        console.log('1. Desktop: a row is one control and overlaps nothing');
        const overlap = await ev(`(() => { const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; const bad = [];
            for (const row of document.querySelectorAll('${ROWS}')) { const nameBtn = row.querySelector('.dt-primary').getBoundingClientRect(); const cells = [...row.querySelectorAll('td')]; const created = cells[cells.length - 2].getBoundingClientRect();
                if (hit(nameBtn, created)) bad.push('the name over Created'); if (row.querySelectorAll('button, a[href]').length !== 2 + row.querySelectorAll('[data-task-link], [data-goal-link]').length) bad.push('not exactly the name, the Task link when the file has a task, and the Details link'); }
            return bad; })()`);
        assert.deepEqual(overlap, [], 'nothing overprints: ' + overlap.join(', '));
        await shot('team-artifacts-ux-desktop');
        // the 28 px Details icon in a 36 px row (#9734): its focus ring stays inside the row's cell, not clipped by it
        await ev(`document.querySelector('${ROWS} .artifact-details').focus(); true`); await sleep(400); // sleep-ok: the ring's transition (base.css) ends before it is measured
        const ring = await ev(`(() => { const b = document.querySelector('${ROWS} .artifact-details'); const cs = getComputedStyle(b), edge = parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset), r = b.getBoundingClientRect(), td = b.closest('td').getBoundingClientRect(); return { focusVisible: b.matches(':focus-visible'), over: Math.max(td.top - (r.top - edge), (r.bottom + edge) - td.bottom), w: cs.outlineWidth, o: cs.outlineOffset, h: Math.round(td.height) }; })()`);
        assert.ok(ring.focusVisible && ring.over <= 0, 'the Details icon\'s focus ring is whole inside its cell: ' + JSON.stringify(ring));
        await shot('team-artifacts-ux-details-focus');

        console.log('2. A singular count');
        await ev(`window.__items = [window.__items[0]]; true`);
        await ev(`import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({ keep: true })); true`);
        await waitFor(`/^1 artifact$/.test((document.querySelector('#agentic-panel-artifacts-view .team-count-line') || {}).textContent || '')`, '"1 artifact"', 8000);
        await ev(`window.__items = ${JSON.stringify(ITEMS)}; import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({ keep: true })); true`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === 3`, 'three rows again', 8000);

        console.log('3. Delete by keyboard: the focus goes to the next row, the previous one, then the search box');
        const deleteRow = async i => {
            await ev(`document.querySelectorAll('${ROWS} .artifact-details')[${i}].focus(); true`);
            await press('Enter', 'Enter', 13);
            await waitFor(`!document.getElementById('agentic-detail-pane').hidden && !!(${FOOT('Delete')})`, 'the sheet', 8000);
            await ev(`(${FOOT('Delete')}).focus(); true`);
            await press('Enter', 'Enter', 13);
            await waitFor(`getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the confirmation', 8000);
            await waitFor(`!!document.activeElement && !!document.activeElement.closest('#confirm-modal') && document.activeElement.id !== 'confirm-modal-yes'`, 'the focus on Cancel', 8000);
            await ev(`document.getElementById('confirm-modal-yes').focus(); true`);
            await press('Enter', 'Enter', 13);
        };
        await deleteRow(1);
        await waitFor(`window.__deletes.length === 1 && document.querySelectorAll('${ROWS}').length === 2`, 'the middle row to go', 8000);
        let a = await active();
        assert.equal(a.body, undefined, 'the focus is not on the page: ' + JSON.stringify(a)); assert.equal(a.row, 1, 'it is on the row that took the deleted one\'s place'); assert.equal(a.inModal, false);
        assert.match(await ev(`document.querySelector('#agentic-panel-artifacts .team-artifacts-status-live').textContent`), /^Deleted report-1\.txt\.$/, 'the live region says it');
        await deleteRow(1); // the last row
        await waitFor(`window.__deletes.length === 2 && document.querySelectorAll('${ROWS}').length === 1`, 'the last row to go', 8000);
        a = await active();
        assert.equal(a.body, undefined, JSON.stringify(a)); assert.equal(a.row, 0, 'the row before it when the last one went');
        await deleteRow(0);
        await waitFor(`window.__deletes.length === 3 && document.querySelectorAll('${ROWS}').length === 0`, 'the only row to go', 8000);
        await sleep(200); // sleep-ok: the focus is placed after the redraw
        a = await active();
        assert.equal(a.body, undefined, JSON.stringify(a)); assert.match(a.label, /^Search this agent/, 'the search box when nothing is left (the tab has no Refresh)');
        assert.equal(await ev(`!!document.querySelector('#agentic-panel-artifacts-view .dt-table')`), false, 'an empty list is its line, with no table header over nothing');
        assert.equal(await ev(`(() => { const l = document.querySelector('#agentic-panel-artifacts-view .team-count-line'); return [...l.childNodes].filter(n => !(n.classList && n.classList.contains('empty-state-hint'))).map(n => n.textContent).join('').trim(); })()`), 'No artifacts yet.'); // the line's own words: its hint ("Files agents share ...") is a span inside it

        console.log('4. An error is red, has no table, and Retry keeps the focus on the panel; a reload keeps it while loading');
        await ev(`window.__mode = 'error'; import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({ keep: true })); true`);
        await waitFor(`!!document.querySelector('#agentic-panel-artifacts-view .team-artifacts-retry')`, 'the error with Retry', 8000);
        const err = await ev(`(() => { const s = document.querySelector('#agentic-panel-artifacts-view .team-artifacts-error'); const calm = document.createElement('p'); calm.className = 'goals-note team-count-line'; document.querySelector('#agentic-panel-artifacts-view').append(calm); const c = getComputedStyle(calm).color; calm.remove();
            return { color: getComputedStyle(s).color, calm: c, role: s.getAttribute('role'), table: !!document.querySelector('#agentic-panel-artifacts-view .dt-table') }; })()`);
        assert.notEqual(err.color, err.calm, 'the error is not the grey of the other lines'); assert.equal(err.role, 'alert'); assert.equal(err.table, false);
        await shot('team-artifacts-ux-error');
        await ev(`window.__mode = 'normal'; window.__items = ${JSON.stringify(ITEMS)}; document.querySelector('#agentic-panel-artifacts-view .team-artifacts-retry').focus(); true`);
        await press('Enter', 'Enter', 13);
        await waitFor(`document.querySelectorAll('${ROWS}').length === 3`, 'the list after Retry', 8000);
        await sleep(200); // sleep-ok: the focus is placed after the redraw
        a = await active();
        assert.equal(a.body, undefined, 'after Retry the focus is on the panel: ' + JSON.stringify(a));
        // A reload while the list loads (the tab reads itself, #7686): the focus stays where it was and the rows stay.
        await ev(`window.__mode = 'deferred'; window.__lists = 0; document.querySelector('#agentic-panel-artifacts-view .list-bar-search').focus(); import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({ keep: true })); true`);
        await waitFor(`window.__lists === 1 && !!window.__release`, 'the load to start', 8000);
        assert.equal(await ev(`document.activeElement === document.querySelector('#agentic-panel-artifacts-view .list-bar-search')`), true, 'the focus stays in the search box while it loads');
        assert.equal(await ev(`document.querySelectorAll('${ROWS}').length`), 3, 'the rows stay on screen while it loads');
        await ev(`window.__release(); true`);
        await waitFor(`document.querySelectorAll('${ROWS}').length === 3 && !document.querySelector('#agentic-panel-artifacts-view .team-count-line').textContent.startsWith('Loading')`, 'the load to end', 8000);
        await ev(`window.__mode = 'normal'; true`);

        console.log('5. A touch phone at 100% and 200% text: 44 px targets, nothing wider than the screen');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await ev(`(document.getElementById('popout-panel-toggle-btn') || document.getElementById('panel-toggle-btn')).click(); true`); await sleep(500); // sleep-ok: the drawer opens over frames
        await ev(`window.switchAgenticTab('artifacts', 'top'); true`); await sleep(300); // sleep-ok: the tab shows over frames
        for (const size of ['', '32px']) {
            await ev(`document.documentElement.style.fontSize = '${size}'; document.getElementById('agentic-state').style.width = ''; true`);
            await ev(`import((window.__coralStatic || '/static/') + 'team_artifacts_page.js').then(m => m.loadArtifacts({ keep: true })); true`);
            await waitFor(`document.querySelectorAll('${ROWS}').length === 3`, 'the rows on the phone', 8000);
            await sleep(400); // sleep-ok: layout settles
            const m = await ev(`(() => { const small = [];
                for (const b of document.querySelectorAll('${ROWS} .dt-primary, ${ROWS} .artifact-details, #agentic-panel-artifacts-view .list-bar-more-btn')) { let r = b.getBoundingClientRect(); if (r.height < 43.5 || (!b.classList.contains('dt-primary') && r.width < 43.5)) small.push((b.getAttribute('aria-label') || b.textContent).slice(0, 20) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
                return { small, docOver: document.documentElement.scrollWidth - innerWidth }; })()`);
            assert.deepEqual(m.small, [], `${size || '100%'}: every control is a 44 px target`);
            assert.ok(m.docOver <= 0, `${size || '100%'}: no sideways scroll`);
            await ev(`document.querySelector('${ROWS} .artifact-details').click(); true`); // the sheet is the Details link; the row itself opens the preview
            await waitFor(`!document.getElementById('agentic-detail-pane').hidden`, 'the sheet on the phone', 8000);
            const sheet = await ev(`(() => { const a = document.getElementById('agentic-detail-pane'); return { small: [...a.querySelectorAll('.detail-foot .btn, .detail-close')].filter(b => { const r = b.getBoundingClientRect(); return r.height < 43.5; }).map(b => b.textContent || b.getAttribute('aria-label')), over: a.scrollWidth - a.clientWidth }; })()`);
            assert.deepEqual(sheet.small, [], `${size || '100%'}: the sheet's buttons are 44 px targets`);
            assert.ok(sheet.over <= 1, `${size || '100%'}: the sheet is not wider than the screen`);
            await shot(`team-artifacts-ux-phone${size ? '-200' : ''}`);
            await ev(`document.querySelector('#agentic-detail-pane .detail-close').click(); true`);
        }
        console.log('PASS');
    } catch (e) {
        console.error(e && e.stack || e);
        process.exitCode = 1;
    } finally {
        try { await client.close(); } catch (_) {}
    }
})();
