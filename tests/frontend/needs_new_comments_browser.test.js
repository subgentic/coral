// #12026 (the Operator): after the Operator comments on a file, an agent's reply in that thread is not a new item: the file's own row in Needs you says "New comments" and is unread again, counted once as that
// same row (the badge, the folder count and the heading agree). Opening the file at its thread clears it; another reply makes it unread again. A file with no news carries no marker. The server's rule (what
// /api/needs-you counts, what the list says, what opening the comments clears) is in internal/server/routes; here the page's side, with the list and the comments stood in at its fetch. 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'new-comments-' + Date.now().toString(36), failures = [];
    const row = name => `[...document.querySelectorAll('#group-table-view tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(name)}))`;
    const badge = () => ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`);
    const marker = name => ev(`!![...(${row(name)}).querySelectorAll('.dt-tag')].find(t => t.textContent.trim() === 'New comments')`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            try {
                await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
                await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
                await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
                assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer',job_title:'Writer'})}).then(r=>r.status)`), 200);
                await ev(`(() => {
                    localStorage.removeItem('coral-inbox-needs-filters');
                    const style = document.createElement('style'); style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.append(style);
                    window.__commentReads = [];
                    const mk = (i, name, tags, news) => ({ id: i.toString(16).padStart(64, '0'), name, media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - (10 - i) * 60000).toISOString(), task_id: 0, source: 'upload', available: true, session_id: 'writer-a', produced_by: 'Writer A', tags, ...(news ? { new_comments: news } : {}) });
                    window.__reviewItems = [mk(1, 'Replied file.txt', ['for review', 'read'], 2), mk(2, 'Quiet file.txt', ['for review'], 0), mk(3, 'Decided file.txt', ['approved'], 1), mk(4, 'Saved file.txt', ['for review', 'saved'], 1)];
                    window.__commentsFail = false;
                    const original = window.fetch, json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (url, opts = {}) => {
                        const u = new URL(String(url), location.origin);
                        if (u.pathname === '/api/board/${team}/artifacts') {
                            const tag = u.searchParams.get('tag');
                            const items = window.__reviewItems.filter(a => !tag || (tag === 'new comments' ? a.new_comments > 0 : a.tags.includes(tag)));
                            return json({ project: '${team}', artifacts: items, has_more: false });
                        }
                        if (u.pathname.startsWith('/api/board/${team}/artifacts/') && u.pathname.endsWith('/tags')) {
                            const id = u.pathname.split('/').at(-2), body = JSON.parse(opts.body);
                            window.__reviewItems.find(a => a.id === id).tags = body.tags; return json({ tags: body.tags });
                        }
                        const parts = u.pathname.split('/');
                        if (parts[1] === 'api' && parts[2] === 'artifacts' && /^[0-9a-f]{64}$/.test(parts[3]) && parts[4] === 'comments' && !parts[5]) { // the Operator reading the thread: the server marks it seen
                            if (window.__commentsFail) return json({ error: 'down' }, 500);
                            window.__commentReads.push(parts[3]);
                            const it = window.__reviewItems.find(a => a.id === parts[3]); if (it) delete it.new_comments;
                            return json({ comments: [], you: { kind: 'owner', can_comment: true, can_lock: true }, locked: false });
                        }
                        if (parts[1] === 'api' && parts[2] === 'artifacts' && /^[0-9a-f]{64}$/.test(parts[3]) && (parts.length === 4 || parts[4] === 'content')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                        return original(url, opts);
                    }; return true;
                })()`);
                await ev(`window.switchNavTab('hub-inbox');true`);
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
                await waitFor(`!!(${row('Replied file.txt')})&&!!(${row('Quiet file.txt')})&&!!(${row('Decided file.txt')})`, 'the three files in Needs you', 15000);
                // the read file with news is unread again, as the same row: the marker, the unread look, and ONE number (3 = this row, the quiet one and the decided one)
                assert.equal(await badge(), '3', 'the file with new comments counts again, once: ' + await badge());
                assert.ok(await marker('Decided file.txt'), 'a file the Operator already approved comes back as its own row, marked');
                assert.ok(await marker('Replied file.txt'), 'its row says New comments');
                assert.ok(!(await marker('Quiet file.txt')), 'a file with no news carries no marker');
                assert.ok(await ev(`(() => { const r = ${row('Replied file.txt')}; return r.classList.contains('dt-unread') && !r.classList.contains('dt-read') && /unread/.test(r.querySelector('.inbox-review-item .sr-only').textContent); })()`), 'the row is unread again');
                assert.equal(await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].filter(r => /Replied file/.test(r.textContent)).length`), 1, 'one row, not a second item');
                assert.equal(await ev(`(document.querySelector('#group-table-view .session-group-count') || {}).textContent`), '3', 'the heading agrees');
                // opening it at its thread clears it
                await ev(`[...(${row('Replied file.txt')}).querySelectorAll('button')].find(b => /^Open/.test(b.getAttribute('aria-label') || b.textContent.trim())).click(); true`);
                await waitFor(`document.body.textContent.includes('Review preview text')`, 'the file opened');
                await waitFor(`window.__commentReads.length > 0`, 'the thread was read');
                await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '2'`, 'the badge drops by one');
                await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
                await waitFor(`!!(${row('Replied file.txt')}) && !![...(${row('Replied file.txt')}).querySelectorAll('.dt-tag')].length === false`, 'the marker is gone', 8000);
                assert.ok(!(await marker('Replied file.txt')), 'no marker once opened');
                assert.ok(await ev(`${row('Replied file.txt')}.classList.contains('dt-read')`), 'the row is read, still listed');
                // a read of the thread that fails marks nothing: the decided file keeps its marker and its count (Security's SHOULD)
                await ev(`window.__commentsFail = true; true`);
                await ev(`[...(${row('Decided file.txt')}).querySelectorAll('button')].find(b => /^Open/.test(b.getAttribute('aria-label') || b.textContent.trim())).click(); true`);
                await waitFor(`document.body.textContent.includes('Review preview text')`, 'the decided file opened');
                await new Promise(r => setTimeout(r, 600)); // sleep-ok: the failed read settles
                await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
                assert.ok(await marker('Decided file.txt'), 'the marker stays after a read that failed');
                assert.equal(await badge(), '2', 'and so does the count');
                await ev(`window.__commentsFail = false; true`);
                await ev(`[...(${row('Decided file.txt')}).querySelectorAll('button')].find(b => /^Open/.test(b.getAttribute('aria-label') || b.textContent.trim())).click(); true`);
                await waitFor(`window.__commentReads.length > 1`, 'the thread was read');
                await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '1'`, 'opened for real: the count drops');
                await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
                // another reply since: unread again
                await ev(`window.__reviewItems[0].new_comments = 1; import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
                await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '2'`, 'a new reply makes it unread again (the quiet file and this one)');
                assert.ok(await marker('Replied file.txt'), 'and the marker is back');
                // a saved file's row says it too, and it is not counted (the Orchestrator's decision, #12026)
                const before = await badge();
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('saved')).then(()=>true)`);
                await waitFor(`[...document.querySelectorAll('.saved-files tbody tr')].some(r => /Saved file\\.txt/.test(r.textContent))`, 'the saved file listed', 10000);
                assert.ok(await ev(`[...document.querySelectorAll('.saved-files tbody tr')].find(r => /Saved file\\.txt/.test(r.textContent)).textContent.includes('New comments')`), 'the saved file says New comments');
                assert.equal(await badge(), before, 'and it is not counted');
                console.log('PASS new comments marker ' + width);
            } catch (error) { failures.push(width + ': ' + error.message); console.error(failures.at(-1)); }
        }
        assert.equal(failures.length, 0, failures.join('\n'));
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
