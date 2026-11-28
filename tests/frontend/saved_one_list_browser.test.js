// Saved is ONE list (#20508): files and messages together, newest saved first; each is a calm row as the Saved mock draws it (#22108): a kind icon, the name, line 2, a tag, the agent and the time. (Fixture from saved_files_actions.) The Saved folder's "Files for review" rows have the same actions as a Needs you row (#11799, the operator: they had Approve, Changes and Deny but no Dismiss): Approve, a Request changes icon and the three dots in their fixed slots (Dismiss and Deny are in the dots, #12231), the three dots with
// "Move to Needs you"; with a mouse the buttons are always shown (Needs you's rule: #11669 had them at the row's hover, #15120 put them on the bottom line), a phone has Deny and Dismiss in the dots. Dismiss takes the file out of Saved with a toast and Undo, and Undo brings it back
// (decisions 'ignore' and 'unignore', nothing else is posted). The server's tags are modelled in the page. 1440 and 390. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const { setTheme } = require('./helpers/contrast');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'savedact-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    const rowsOf0 = () => ev(`[...document.querySelectorAll('.saved-ledger .sl-row')].map(r => (r.textContent.match(/plan-\\d/) || [''])[0])`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 800, false], [390, 800, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = i => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'saved'], uploader: 'Plan Writer', produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?', ...(i === 2 ? { starred: true, version_line: 'version 3 of plan-2.md', goal_id: 47, goal_title: 'Faster order imports', review_question: 'Approve this queue design: named presets only, one heavy job a machine, the light ones beside it, and the old runner kept for a week?' } : {}), ...(i === 1 ? { saved_at: new Date(Date.now() - 60000).toISOString() } : {}) }); // plan-1 was saved later though plan-2 is the newer file
                window.__items = [1, 2].map(item).concat({ ...item(3), name: 'release-notes.md', tags: ['approved', 'saved'], review_question: '', saved_at: new Date(Date.now() - 3 * 86400000).toISOString() }); // decided and still saved (#22133): under Done, with its verdict window.__calls = [];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase(), m = u.pathname.match(/^\\/api\\/board\\/${team}\\/artifacts(?:\\/([0-9a-f]{64})\\/(review|tags))?$/);
                    if (method !== 'GET' && /^\\/api\\/board\\//.test(u.pathname)) window.__calls.push({ method, path: u.pathname.replace('/api/board/${team}', ''), body: opts.body ? JSON.parse(opts.body) : null });
                    if (u.pathname === '/api/saved' && method === 'GET') return json({ open: 2, done: 1, items: [{ id: 13, kind: 'board', ref: 'team-x', key: '7', title: 'Release Bot', snippet: 'v2.1.22 is out. The notes are on the release page.', team: 'team-x', saved_at: new Date(Date.now() - 2 * 86400000).toISOString(), done_at: new Date(Date.now() - 3600000).toISOString() }, { id: 11, kind: 'board', ref: 'team-x', key: '5', title: 'Backend Dev', snippet: 'the retry budget is per request. Each call gets three tries and a jittered back-off, and the limit is read from the team settings so it can be tuned without a release.', team: 'team-x', saved_at: new Date(Date.now() - 30000).toISOString(), goal: { id: 47, title: 'Faster order imports' } }, { id: 12, kind: 'board', ref: 'team-x', key: '6', title: 'Orchestrator', snippet: 'ship it when green', team: 'team-x', saved_at: new Date(Date.now() - 86400000).toISOString() }] });
                    if (u.pathname === '/api/team-artifacts') return new Promise(done => setTimeout(() => done(json(window.__reviewFixturePage(u,location.href,{'${team}':window.__items}))), window.__ntDelay || 0)); // the Inbox also reads the no-team list (#13574): this suite's files are all on its one team
                    if (!m) return original(url, opts);
                    if (!m[1]) return json({ project: '${team}', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    const it = window.__items.find(a => a.id === m[1]), body = opts.body ? JSON.parse(opts.body) : {};
                    if (m[2] === 'review') {
                        if (body.decision === 'ignore') { it.tags = it.tags.filter(x => x !== 'for review').concat('ignored'); return json({ id: it.id, tags: it.tags }); }
                        if (body.decision === 'unignore') { it.tags = it.tags.filter(x => x !== 'ignored').concat('for review'); return json({ id: it.id, tags: it.tags }); }
                        if (body.decision === 'unsave') { it.tags = it.tags.filter(x => x !== 'saved'); return json({ id: it.id, tags: it.tags }); }
                    }
                    return json({ id: it.id, tags: it.tags }); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('saved')).then(() => true)`);
            await waitFor(`document.querySelectorAll('.saved-ledger .sl-row').length === 4`, at + 'Saved is one list of the two files and the two messages', 15000);
            await ev(framesJs(4));
            const shape = await ev(`(() => { const rows = [...document.querySelectorAll('.saved-ledger .sl-row')]; return { lists: document.querySelectorAll('.saved-ledger').length, order: rows.map(r => r.classList.contains('sl-file') ? 'file' : 'message'), names: rows.map(r => !!r.querySelector('.sl-line1 .sl-name')), icons: rows.map(r => r.querySelector('.sl-icon')?.textContent), tags: rows.map(r => r.querySelector('.sl-tag')?.textContent || ''), approve: rows.filter(r => r.querySelector('.inbox-approve-action, [data-slot="approve"]')).length, count: document.querySelector('.saved-ledger-count')?.textContent || '', heads: document.querySelectorAll('.saved-ledger-wrap .inbox-card-head').length }; })()`);
            check(shape.lists === 1, at + 'one list, not a files list and a messages list: ' + JSON.stringify(shape));
            check(JSON.stringify(shape.order) === JSON.stringify(['message', 'file', 'file', 'message']), at + 'newest saved first, files and messages mixed (the older message last): ' + JSON.stringify(shape.order));
            const plans = (await rowsOf0()).filter(Boolean);
            check(JSON.stringify(plans) === JSON.stringify(['plan-1', 'plan-2']), at + 'a file saved later sorts first, by saved_at not by its version time: ' + JSON.stringify(plans));
            const age = await ev(`(() => { const r = [...document.querySelectorAll('.saved-ledger .sl-row')].find(x => /plan-1/.test(x.textContent)); return r ? (r.querySelector('.sl-time')?.textContent || r.textContent) : ''; })()`);
            if (!mobile) check(/1 min ago/.test(age) && !/8 min ago/.test(age), at + 'the time a Saved file shows is saved_at (1 min ago), not its version time (8 min ago): ' + age.replace(/\s+/g, ' ').slice(0, 160));
            check(shape.names.every(Boolean) && JSON.stringify(shape.icons) === JSON.stringify(['chat_bubble_outline', 'description', 'description', 'chat_bubble_outline']), at + 'every row: a grey kind icon and the name on line 1 (#22108): ' + JSON.stringify(shape));
            check(JSON.stringify(shape.tags) === JSON.stringify(['', 'To review', 'To review', '']) && shape.approve === 0, at + 'a file still to decide says To review, a message has no tag, and no row has Approve: ' + JSON.stringify([shape.tags, shape.approve]));
            if (!mobile) check(/^4 saved · 2 files, 2 messages · newest saved first$/.test(shape.count.replace(/\s+/g, ' ').trim()) && shape.heads === 0, at + 'the count is said once, above the list: ' + JSON.stringify([shape.count, shape.heads]));
            for (const theme of ['light', 'dark']) { await setTheme(ev, theme); await ev(framesJs(3)); await shot(`saved-one-list-${w}-${theme}`); }
            // the states the first picture has not (the designer's point 10): the pointer on a row, a starred file with its version, goal and long question; then the open phone menu; then the Done tab
            for (const theme of ['light', 'dark']) {
                await setTheme(ev, theme); await ev(framesJs(3));
                if (!mobile) {
                    const p = await ev(`(() => { const r = [...document.querySelectorAll('.saved-ledger .sl-row')].find(x => /plan-1/.test(x.textContent)).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height, next: r.bottom }; })()`);
                    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y }); await ev(framesJs(2));
                    const hov = await ev(`(() => { const r = [...document.querySelectorAll('.saved-ledger .sl-row')].find(x => /plan-1/.test(x.textContent)); const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; const bs = [...r.querySelectorAll('.sl-actions button')].filter(b => !b.closest('[role=menu]')), rb = bs.map(b => b.getBoundingClientRect()); const more = bs.find(b => b.classList.contains('inbox-row-more-toggle')); return { acts: vis(r.querySelector('.sl-actions')), right: vis(r.querySelector('.sl-right')), h: r.getBoundingClientRect().height, bottom: r.getBoundingClientRect().bottom, words: bs.map(b => b.textContent.trim()), gaps: rb.slice(1).map((b, i) => Math.round(b.left - rb[i].right)), outlined: !!more && more.classList.contains('btn') && !more.classList.contains('btn-quiet') && parseFloat(getComputedStyle(more).borderTopWidth) > 0 }; })()`);
                    check(hov.acts && !hov.right, at + theme + ': the pointer on a row shows its buttons in place of the right side: ' + JSON.stringify(hov));
                    check(Math.abs(hov.h - p.h) < 1 && Math.abs(hov.bottom - p.next) < 1, at + theme + ': the row keeps its height on hover, nothing under it moves: ' + JSON.stringify([p.h, hov.h]));
                    check(JSON.stringify(hov.words) === JSON.stringify(['Remove from Saved', 'Star', 'Moreexpand_more']) && hov.outlined && hov.gaps.every(g => g >= 6 && g <= 14), at + theme + ': Remove from Saved, Star and an outlined More with its arrow, about 10 px apart: ' + JSON.stringify(hov));
                    await shot(`saved-states-${w}-hover-${theme}`);
                    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 790 });
                } else {
                    await ev(`document.querySelector('.saved-ledger button[aria-label="More actions for plan-2.md"]').click(); true`);
                    await waitFor(`!!document.querySelector('.menu-item[aria-label^="Remove from Saved"]')`, at + 'the row\'s menu opens', 5000);
                    await shot(`saved-states-${w}-menu-${theme}`);
                    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.body.click(); true`); await ev(framesJs(2));
                }
            }
            const star = await ev(`(() => { const r = [...document.querySelectorAll('.saved-ledger .sl-row')].find(x => /plan-2/.test(x.textContent)); return { star: !!r.querySelector('.sl-star-on'), ver: (r.querySelector('.sl-ver') || {}).textContent || '', goal: (r.querySelector('.sl-goal') || {}).textContent || '' }; })()`);
            check(star.star && star.ver === '(version 3)' && (mobile || /#47 Faster order imports/.test(star.goal)), at + 'a starred file shows its star, its version in brackets and its goal: ' + JSON.stringify(star));
            const mgoal = await ev(`(() => { const r = [...document.querySelectorAll('.saved-ledger .sl-row')].find(x => /retry budget/.test(x.textContent)); const g = r.querySelector('.sl-goal'); return { text: g ? g.textContent : '', label: g ? g.getAttribute('aria-label') : '' }; })()`);
            check(mobile ? !mgoal.text : /#47 Faster order imports/.test(mgoal.text) && mgoal.label === 'Open goal #47 Faster order imports', at + "a board message shows its task's goal as a link (#22133): " + JSON.stringify(mgoal));
            await ev(`[...document.querySelectorAll('#group-table-view .team-tb-pills .goals-chip')].find(c => /^Done/.test(c.textContent.trim())).click(); true`);
            await waitFor(`!!document.querySelector('.saved-ledger') && /v2\\.1\\.22 is out/.test(document.querySelector('.saved-ledger').textContent)`, at + 'the Done tab lists the message marked done', 8000);
            const done = await ev(`(() => { const rows = [...document.querySelectorAll('.saved-ledger .sl-row')]; return { rows: rows.map(r => (r.querySelector('.sl-name') || {}).textContent + '|' + ((r.querySelector('.sl-tag') || {}).textContent || '')), count: (document.querySelector('.saved-ledger-count') || {}).textContent || '' }; })()`);
            check(done.rows.length === 2 && done.rows.includes('release-notes.md|Approved') && done.rows.some(x => /^v2\.1\.22 is out/.test(x)) && (mobile || /^2 saved · 1 file, 1 message · /.test(done.count.replace(/\s+/g, ' ').trim())), at + 'the Done tab: the message marked done and the approved file with its verdict as the tag (#22133): ' + JSON.stringify(done));
            for (const theme of ['light', 'dark']) { await setTheme(ev, theme); await ev(framesJs(3)); await shot(`saved-states-${w}-done-${theme}`); }
            if (mobile) await ev(`[...document.querySelectorAll('#group-table-view .team-tb-pills .goals-chip')].find(c => /^Open/.test(c.textContent.trim())).click(); true`);
            if (!mobile) { // a touch screen wider than a phone has no hover: the buttons and the right side show together, on one line (the designer's point 7)
                await Emulation.setDeviceMetricsOverride({ width: 1024, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 }); await ev(`[...document.querySelectorAll('#group-table-view .team-tb-pills .goals-chip')].find(c => /^Open/.test(c.textContent.trim())).click(); true`); // the list is drawn again with no hover
                await waitFor(`!!document.querySelector('.saved-ledger') && /plan-1/.test(document.querySelector('.saved-ledger').textContent)`, at + 'Open again', 8000); await ev(framesJs(3));
                const touch = await ev(`(() => { const r = [...document.querySelectorAll('.saved-ledger .sl-row')].find(x => /plan-2/.test(x.textContent)); const a = r.querySelector('.sl-actions').getBoundingClientRect(), g = r.querySelector('.sl-right').getBoundingClientRect(), m = r.querySelector('.sl-main').getBoundingClientRect(); return { acts: a.width > 0, right: g.width > 0, oneLine: Math.abs((a.top + a.bottom) / 2 - (g.top + g.bottom) / 2) < 4, rowH: Math.round(r.getBoundingClientRect().height), mainH: Math.round(m.height), apart: a.left >= g.right - 1, only: [...r.querySelectorAll('.sl-actions button')].filter(x => !x.closest('[role=menu]')).map(x => x.getAttribute('aria-label')) }; })()`);
                check(touch.acts && touch.right && touch.oneLine && touch.apart && touch.rowH < touch.mainH + 40 && touch.only.length === 1 && /^More actions for /.test(touch.only[0]), at + 'wide touch: the phone\'s "..." menu beside the right side, on the row\'s one line: ' + JSON.stringify(touch));
                await setTheme(ev, 'light'); await ev(framesJs(3)); await shot('saved-states-1024-touch-light');
                await Emulation.setTouchEmulationEnabled({ enabled: false });
            }
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('saved_one_list_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
