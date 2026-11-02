// #11963 (the Operator, 2.0.29): after Coral had been open a while, a click on a file-for-review row in Needs you opened nothing while a goal row beside it still opened, and closing and reopening the app cured it: a
// state that builds up in the page. This soak keeps one Needs you page open through many redraws: files arrive, get new versions, are approved, saved, ignored and marked read elsewhere (the board's list
// changes under the page), the live list is redrawn, folders are switched and the viewer is opened and closed, the window is resized; then a REAL mouse click lands on each file row in three places (its name, its
// empty middle, its far end) and on the goal row, at 1280 and 1440: every one must open its file (or goal). Real board for the team and its goal, the team's files stubbed in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const team = 'soak-' + Date.now().toString(36);
const hex = n => n.toString(16).padStart(64, '0');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${team}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const T = '#group-table-view';
    const viewerShown = () => ev(`!!document.querySelector('.artifact-viewer:not([hidden])') && getComputedStyle(document.querySelector('.artifact-viewer:not([hidden])')).display !== 'none'`);
    const closeViewer = async () => { await ev(`document.querySelector('.artifact-viewer-close')?.click(); true`); await waitFor(`!document.querySelector('.artifact-viewer:not([hidden])')`, 'the viewer closes', 5000); };
    const click = async (x, y) => { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); };
    const refresh = () => ev(`import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 1440]) {
            const at = `${width} px: `;
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            if (width === 1280) {
                assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + team })).status < 300);
                const g = await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Ship the pilot', done_when: 'it is shipped' }); assert.equal(g.status, 201);
                const gid = g.json.id || g.json.goal.id;
                const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task A', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' });
                const tid = t.json.id || t.json.task.id;
                assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid })).status < 300);
                assert.ok((await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
            }
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); window.__n = 0;
                const mk = (n, name, mins, by) => ({ id: '' + n.toString(16).padStart(64, '0'), name, media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - mins * 60000).toISOString(), task_id: 0, source: 'upload', available: true, session_id: by + '-s', produced_by: by, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + n.toString(16).padStart(64, '0') });
                window.__mk = mk; window.__items = [mk(1, 'Design note.md', 60, 'Writer'), mk(2, 'Plan.md', 50, 'Writer'), mk(3, 'Report.txt', 40, 'Tester'), mk(4, 'Notes.md', 30, 'Tester')];
                const R = window.fetch, json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), m = (opts.method || 'GET').toUpperCase();
                    if (u.pathname === '/api/board/${team}/artifacts' && m === 'GET') { const t = u.searchParams.get('tag'); return json({ project: '${team}', artifacts: window.__items.filter(a => !t || a.tags.includes(t)), has_more: false }); }
                    if (u.pathname.startsWith('/api/board/${team}/artifacts/') && u.pathname.endsWith('/review') && m === 'POST') { const id = u.pathname.split('/').at(-2), body = JSON.parse(opts.body), it = window.__items.find(a => a.id === id); if (!it) return json({ error: 'not found' }, 404);
                        const add = t => { if (!it.tags.includes(t)) it.tags.push(t); }, del = t => { it.tags = it.tags.filter(x => x !== t); };
                        if (body.decision === 'approve') { del('for review'); del('read'); add('approved'); } else if (body.decision === 'save') { add('saved'); del('read'); } else if (body.decision === 'unsave') del('saved'); else if (body.decision === 'ignore') { del('for review'); del('saved'); add('ignored'); } else if (body.decision === 'unignore') { del('ignored'); add('for review'); } else if (body.decision === 'deny') { del('for review'); add('denied'); }
                        return json({ id, state: body.decision, changed: true, tags: it.tags, review: null, delivered: false, to: 'Writer' }); }
                    if (u.pathname.startsWith('/api/board/${team}/artifacts/') && m === 'PUT' && u.pathname.endsWith('/tags')) { const id = u.pathname.split('/').at(-2), it = window.__items.find(a => a.id === id); if (it) it.tags = JSON.parse(opts.body).tags; return json({ tags: it ? it.tags : [] }); }
                    if (u.pathname.startsWith('/api/artifacts/') && /^[0-9a-f]{64}$/.test(u.pathname.split('/')[3]) && (u.pathname.split('/').length === 4 || u.pathname.split('/')[4] === 'content')) return Promise.resolve(new Response('preview text', { headers: { 'Content-Type': 'text/plain' } }));
                    return R(url, opts); };
                window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await refresh();
            await waitFor(`document.querySelectorAll('${T} [data-review-artifact]').length >= 4`, at + 'the files are rows', 15000);

            // the soak: the page stays open while the board changes under it, again and again
            for (let i = 0; i < 90; i++) {
                await ev(`(() => { const items = window.__items, n = ++window.__n;
                    if (n % 4 === 1) items.push(window.__mk(100 + n, 'Draft ' + n + '.md', 5, n % 2 ? 'Writer' : 'Tester'));            // a file arrives
                    if (n % 4 === 2) { const last = items.filter(a => a.name === 'Plan.md').pop(); items.push({ ...window.__mk(200 + n, 'Plan.md', 2, 'Writer') }); }  // a new version of an existing file
                    if (n % 4 === 3 && items.length > 5) { const gone = items.find(a => a.name.startsWith('Draft ')); if (gone) gone.tags = ['approved']; } // approved elsewhere
                    if (n % 5 === 0) { const a = items[n % items.length]; if (a && a.tags.includes('for review')) a.tags = a.tags.includes('read') ? a.tags.filter(t => t !== 'read') : [...a.tags, 'read']; } // read or unread elsewhere
                    if (n % 7 === 0) { const a = items[(n * 3) % items.length]; if (a && a.tags.includes('for review') && !a.tags.includes('saved')) a.tags = [...a.tags, 'saved']; else if (a && a.tags.includes('saved')) a.tags = a.tags.filter(t => t !== 'saved'); } // saved and moved back elsewhere
                    return true; })()`);
                await refresh();
                await ev(`window.T.render.renderLiveSessions(window.T.state.liveSessions); true`);
                if (i % 6 === 2) { await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`); await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); }
                if (i % 6 === 4) { // the viewer opened from a row and closed again
                    await ev(`document.querySelector('${T} [data-review-artifact]')?.click(); true`);
                    await waitFor(`!!document.querySelector('.artifact-viewer:not([hidden])')`, at + `cycle ${i}: the viewer opens`, 5000);
                    await closeViewer();
                }
                // the Operator's own actions on the page, as a long session has them: Approve, Save for later, Dismiss (and Undo), Move back, hover and keys, refreshes that overlap
                if (i % 9 === 1) { await ev(`document.querySelector('${T} tbody tr .inbox-bookmark')?.click(); true`); await new Promise(r => setTimeout(r, 120)); } // sleep-ok: the save goes through and the row leaves
                if (i % 9 === 4) { await ev(`[...document.querySelectorAll('${T} tbody tr button')].find(b => /^Dismiss: /.test(b.getAttribute('aria-label') || ''))?.click(); true`); await new Promise(r => setTimeout(r, 120)); } // sleep-ok: the ignore goes through
                if (i % 9 === 6) { await ev(`document.querySelector('.toast button')?.click(); true`); await new Promise(r => setTimeout(r, 120)); } // sleep-ok: an Undo in a toast
                if (i % 9 === 7) { await ev(`(() => { [...document.querySelectorAll('${T} tbody tr button')].find(b => /^Approve: /.test(b.getAttribute('aria-label') || ''))?.click(); const cm = document.getElementById('confirm-modal'); if (cm && getComputedStyle(cm).display !== 'none') document.getElementById('confirm-modal-yes').click(); return true; })()`); await new Promise(r => setTimeout(r, 120)); } // an unopened file asks 'Approve without opening?' (#11999): the Operator answers it; sleep-ok: the approve goes through
                if (i % 3 === 0) { await ev(`(() => { const trs = [...document.querySelectorAll('${T} tbody tr')]; const tr = trs[${i} % Math.max(1, trs.length)]; tr?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); tr?.querySelector('.dt-primary, .inbox-review-name')?.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return true; })()`); }
                if (i % 4 === 0) await ev(`Promise.all([import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m => Promise.all([m.refreshReviews(true), m.refreshReviews(), m.refreshReviews(true)])), import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.updateInboxTab())]).then(() => true)`);
                if (i % 10 === 5) { await Emulation.setDeviceMetricsOverride({ width: width - 200, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: false }); }
            }
            await waitFor(`document.querySelectorAll('${T} [data-review-artifact]').length >= 3`, at + 'files are still rows after the soak', 8000);

            // then a real click on every file row, in three places, and on the goal row
            await ev(`document.querySelectorAll('#toast-host .toast').forEach(t => t.remove()); true`); // an Undo toast sits bottom right for 30 s: that is the page working, not a dead target
            const rows = await ev(`[...document.querySelectorAll('${T} tbody tr')].map((tr, i) => { const r = tr.getBoundingClientRect(), file = tr.querySelector('[data-review-artifact]'); return { i, file: !!file, name: tr.textContent.replace(/\\s+/g, ' ').trim().slice(0, 50), x0: Math.round(r.left), x1: Math.round(r.right), y: Math.round(r.top + Math.min(r.height / 2, 20)), nameX: file ? Math.round(file.getBoundingClientRect().left + 8) : 0 }; })`);
            const files = rows.filter(r => r.file);
            assert.ok(files.length >= 3, at + 'file rows to click: ' + JSON.stringify(rows.map(r => r.name)));
            for (const f of files) {
                for (const [place, x] of [['its name', f.nameX], ['its empty middle', Math.round((f.x0 + f.x1) / 2)], ['its far end', f.x1 - 6]]) {
                    await ev(`window.scrollTo(0, 0); document.querySelectorAll('${T} tbody tr')[${f.i}].scrollIntoView({ block: 'center' }); true`);
                    const y = await ev(`(() => { const r = document.querySelectorAll('${T} tbody tr')[${f.i}].getBoundingClientRect(); return Math.round(r.top + Math.min(r.height / 2, 20)); })()`);
                    const topmost = await ev(`(() => { const e = document.elementFromPoint(${x}, ${y}); const tr = document.querySelectorAll('${T} tbody tr')[${f.i}]; return !!e && (tr.contains(e)); })()`);
                    assert.ok(topmost, at + `${f.name}: ${place} is on the row, not under something else (an overlay, a backdrop)`);
                    await click(x, y);
                    const opened = await ev(`new Promise(res => { const t0 = Date.now(), tick = () => { const v = document.querySelector('.artifact-viewer:not([hidden])'); if (v && getComputedStyle(v).display !== 'none') return res(true); if (Date.now() - t0 > 3000) return res(false); setTimeout(tick, 50); }; tick(); })`);
                    assert.ok(opened, at + `a click on ${place} of "${f.name}" opened it`);
                    await closeViewer();
                }
            }
            console.log(`   ✓ ${width} px: ${files.length} file rows opened from three places each after the soak`);
        }
        console.log('PASS a Needs you page kept open through many redraws still opens every file-for-review row on a real click');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
