// #12026 (the Operator): after the Operator comments on a file, an agent's reply in that thread is not a new item: the file's own row in Needs you says "New comments" and is unread again, counted once as that
// same row (the badge, the folder count and the heading agree). Opening the file at its thread clears it; another reply makes it unread again. A file with no news carries no marker. The server's rule (what
// /api/needs-you counts, what the list says, what opening the comments clears) is in internal/server/routes; here the page's side, with the list and the comments stood in at its fetch. 1280 and 390.
// #22094: Waiting on you is the Needs you ledger (needs_ledger.js): a file is an article.nl-row.nl-file in its goal group, its name the .nl-file-open button, unread shows .nl-new, a decided file's
// line '.nl-file-open .nl-meta' reads 'Approved · N new comments', the list's count is the .nl-summary 'N items · M new'. Waiting on an agent and Saved are still tables.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'new-comments-' + Date.now().toString(36), failures = [];
    const row = name => `[...document.querySelectorAll('#group-table-view tbody tr, #group-table-view .nl-row')].find(r=>r.textContent.includes(${JSON.stringify(name)}))`; // Waiting on you is the ledger (article.nl-row), Waiting on an agent the table
    const badge = () => ev(`document.getElementById('nav-tab-hub-inbox-badge').textContent`);
    const marker = name => ev(`/[1-9][0-9]* new comments?/i.test((${row(name)}).textContent)`);
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
                    localStorage.removeItem('coral-inbox-needs-filters'); localStorage.removeItem('coral-inbox-needs-tab');
                    const style = document.createElement('style'); style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.append(style);
                    window.__commentReads = [];
                    const mk = (i, name, tags, news) => ({ id: i.toString(16).padStart(64, '0'), name, media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - (10 - i) * 60000).toISOString(), task_id: 0, source: 'upload', available: true, session_id: 'writer-a', produced_by: 'Writer A', tags, ...(news ? { new_comments: news } : {}) });
                    window.__reviewItems = [mk(1, 'Replied file.txt', ['for review', 'read'], 2), mk(2, 'Quiet file.txt', ['for review'], 0), mk(3, 'Decided file.txt', ['approved'], 1), mk(4, 'Saved file.txt', ['for review', 'saved'], 1), mk(5, 'Changes file.txt', ['for review', 'changes requested'], 1), mk(6, 'Waiting file.txt', ['for review', 'changes requested'], 0)];
                    window.__commentsFail = false; window.__tagReads = [];
                    const original = window.fetch, json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (url, opts = {}) => {
                        const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': window.__reviewItems}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                        if (u.pathname === '/api/board/${team}/artifacts') {
                            const tag = u.searchParams.get('tag'); window.__tagReads.push(tag);
                            const items = window.__reviewItems.filter(a => !tag || a.tags.includes(tag) || (tag === 'for review' && a.new_comments > 0 && /approved|denied/.test(a.tags.join(' ')) && !a.tags.some(x => ['saved', 'ignored', 'superseded'].includes(x)))); // the server's rule (#12097): the for-review list also holds a decided file with news
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
                await waitFor(`!!(${row('Replied file.txt')})&&!!(${row('Quiet file.txt')})&&!!(${row('Decided file.txt')})&&!!(${row('Changes file.txt')})`, 'the four files in Needs you', 15000);
                await ev(`document.querySelectorAll('#group-table-view .nl-group-toggle[aria-expanded=false]').forEach(b => b.click()); true`); // the files' group holds no question, so it starts folded
                assert.ok(await ev(`!${row('Waiting file.txt')}`), 'a sent-back file is not on Waiting on you');
                await ev(`document.querySelector('[data-needs-tab="agent"]').click(); true`); await waitFor(`!!(${row('Waiting file.txt')})`, 'it is on Waiting on an agent', 8000);
                assert.ok(await ev(`(${row('Waiting file.txt')}).classList.contains('dt-read')`), 'a sent-back file remains visible and uncounted while waiting on its agent');
                await ev(`document.querySelector('[data-needs-tab="you"]').click(); true`); await waitFor(`!!(${row('Replied file.txt')})?.closest('.needs-ledger')`, 'and back on Waiting on you', 8000); await ev(`document.querySelectorAll('#group-table-view .nl-group-toggle[aria-expanded=false]').forEach(b => b.click()); true`);
                // #22094: an undecided file's row in the ledger carries only the New tag; the 'N new comments' words are drawn for a decided file alone (needs_ledger.js fileQuestion): kept as a check, recorded so the rest still runs
                if (!(await marker('Changes file.txt'))) failures.push(width + ': with changes requested AND an agent reply in the thread it is back, but its row does not say how many new comments: ' + await ev(`(${row('Changes file.txt')}).textContent`));
                // the read file with news is unread again, as the same row: the marker, the unread look, and ONE number (4 = this row, the quiet one, the decided one and the changes-requested one)
                assert.equal(await badge(), '4', 'the file with new comments counts again, once: ' + await badge());
                assert.ok(await marker('Decided file.txt'), 'a file the Operator already approved comes back as its own row, marked');
                if (!(await marker('Replied file.txt'))) failures.push(width + ': the read file with agent replies is unread again, but its row does not say New comments: ' + await ev(`(${row('Replied file.txt')}).textContent`));
                // #16399 (Beta Tester): an approved file's new comment is to be read, not reviewed again: the row says Approved (not For review) and offers no Approve or Request changes. In the ledger no file row carries
                // Approve / Request changes (review decisions stay in the viewer, needs_ledger.js), so the still-waiting file's For review / Approve / Request changes check is retired (removed by design: it sits under the To review subhead)
                const decided = await ev(`(() => { const r = ${row('Decided file.txt')}, m = r.querySelector('.nl-file-open .nl-meta'); return { meta: m ? m.textContent : '', approve: !!r.querySelector('[data-slot=approve]'), changes: !!r.querySelector('[data-slot=changes]') }; })()`);
                assert.ok(/^Approved · 1 new comments?$/.test(decided.meta) && !/For review/.test(decided.meta) && !decided.approve && !decided.changes, 'an approved file with a new comment says Approved (not For review) in its line, and asks for no new decision: ' + JSON.stringify(decided));
                // #17696 (walk 80 #15) "Got it", not "Dismiss", on the decided row's menu: retired, a file row in the ledger has no row menu or hover actions (needs_ledger.js rowNode draws them for non-file rows only); its way out is the summary's bulk Dismiss
                assert.equal(await ev(`(${row('Replied file.txt')}).closest('.nl-group-body')?.querySelector('.nl-subhead')?.firstChild.textContent || ''`), 'To review', 'a file still waiting for review is listed under To review');
                assert.ok(await ev(`(() => { const m = (${row('Decided file.txt')}).querySelector('.nl-file-open .nl-meta'), t = m.closest('.nl-title'); return /1 new comments?$/.test(m.textContent) && t.scrollWidth <= t.clientWidth + 1; })()`), 'the new comments words are whole, not cut to New comme... (#17454)');
                assert.ok(!(await marker('Quiet file.txt')), 'a file with no news carries no marker');
                assert.ok(await ev(`!!(${row('Replied file.txt')}).querySelector('.nl-new')`), 'the row is unread again (New)');
                assert.equal(await ev(`[...document.querySelectorAll('#group-table-view .nl-row')].filter(r => /Replied file/.test(r.textContent)).length`), 1, 'one row, not a second item');
                assert.match(await ev(`document.querySelector('#group-table-view .nl-summary').textContent`), /^4 items ?· 4 new/, 'the list\'s summary agrees');
                assert.ok(!(await ev(`window.__tagReads.includes('new comments')`)), 'the page asks for one list (for review), not a second one for news (#12097)');
                // opening it at its thread clears it
                await ev(`(${row('Replied file.txt')}).querySelector('.nl-file-open').click(); true`);
                await waitFor(`document.body.textContent.includes('Review preview text')`, 'the file opened');
                await waitFor(`window.__commentReads.length > 0`, 'the thread was read');
                await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '3'`, 'the badge drops by one');
                await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
                await waitFor(`!!(${row('Replied file.txt')}) && !/[1-9][0-9]* new comments?/i.test((${row('Replied file.txt')}).textContent) && !(${row('Replied file.txt')}).querySelector('.nl-new')`, 'the marker is gone', 8000);
                assert.ok(!(await marker('Replied file.txt')), 'no marker once opened');
                assert.ok(await ev(`!(${row('Replied file.txt')}).querySelector('.nl-new')`), 'the row is read (no New), still listed');
                // a read of the thread that fails marks nothing: the decided file keeps its marker and its count (Security's SHOULD)
                await ev(`window.__commentsFail = true; true`);
                await ev(`(${row('Decided file.txt')}).querySelector('.nl-file-open').click(); true`);
                await waitFor(`document.body.textContent.includes('Review preview text')`, 'the decided file opened');
                await new Promise(r => setTimeout(r, 600)); // sleep-ok: the failed read settles
                await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
                assert.ok(await marker('Decided file.txt'), 'the marker stays after a read that failed');
                assert.equal(await badge(), '3', 'and so does the count');
                await ev(`window.__commentsFail = false; true`);
                await ev(`(${row('Decided file.txt')}).querySelector('.nl-file-open').click(); true`);
                await waitFor(`window.__commentReads.length > 1`, 'the thread was read');
                await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '2'`, 'opened for real: the count drops');
                await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
                // another reply since: unread again
                await ev(`window.__reviewItems[0].new_comments = 1; import((window.__coralStatic||'/static/')+'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
                await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '3'`, 'a new reply makes it unread again (the quiet file, the changes-requested one and this one)');
                if (!(await marker('Replied file.txt'))) failures.push(width + ': another reply makes it unread again, but its row does not say New comments: ' + await ev(`(${row('Replied file.txt')}).textContent`));
                // a saved file's row says it too, and it is not counted (the Orchestrator's decision, #12026)
                const before = await badge();
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('saved')).then(()=>true)`);
                await waitFor(`[...document.querySelectorAll('.saved-ledger .sl-row')].some(r => /Saved file\\.txt/.test(r.textContent))`, 'the saved file listed', 10000);
                assert.ok(await ev(`[...document.querySelectorAll('.saved-ledger .sl-row')].find(r => /Saved file\\.txt/.test(r.textContent)).textContent.includes('New comments')`), 'the saved file says New comments');
                assert.equal(await badge(), before, 'and it is not counted');
                console.log('PASS new comments marker ' + width);
            } catch (error) { failures.push(width + ': ' + error.message); console.error(failures.at(-1)); }
        }
        assert.equal(failures.length, 0, failures.join('\n'));
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
