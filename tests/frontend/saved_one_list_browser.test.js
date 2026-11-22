// Saved is ONE list in the Inbox's row (#20508): files and messages together, newest saved first; each is a kind row with its preview and its buttons under it. (Fixture from saved_files_actions.) The Saved folder's "Files for review" rows have the same actions as a Needs you row (#11799, the operator: they had Approve, Changes and Deny but no Dismiss): Approve, a Request changes icon and the three dots in their fixed slots (Dismiss and Deny are in the dots, #12231), the three dots with
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
    const rowsOf0 = () => ev(`[...document.querySelectorAll('.saved-files tbody tr')].map(r => (r.textContent.match(/plan-\\d/) || [''])[0])`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 800, false], [390, 800, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = i => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'saved'], uploader: 'Plan Writer', produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?', ...(i === 1 ? { saved_at: new Date(Date.now() - 60000).toISOString() } : {}) }); // plan-1 was saved later though plan-2 is the newer file
                window.__items = [1, 2].map(item); window.__calls = [];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase(), m = u.pathname.match(/^\\/api\\/board\\/${team}\\/artifacts(?:\\/([0-9a-f]{64})\\/(review|tags))?$/);
                    if (method !== 'GET' && /^\\/api\\/board\\//.test(u.pathname)) window.__calls.push({ method, path: u.pathname.replace('/api/board/${team}', ''), body: opts.body ? JSON.parse(opts.body) : null });
                    if (u.pathname === '/api/saved' && method === 'GET') return json({ open: 2, done: 0, items: [{ id: 11, kind: 'board', ref: 'team-x', key: '5', title: 'Backend Dev', snippet: 'the retry budget is per request', team: 'team-x', saved_at: new Date(Date.now() - 30000).toISOString() }, { id: 12, kind: 'board', ref: 'team-x', key: '6', title: 'Orchestrator', snippet: 'ship it when green', team: 'team-x', saved_at: new Date(Date.now() - 86400000).toISOString() }] });
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
            await waitFor(`document.querySelectorAll('.saved-files tbody tr').length === 4`, at + 'Saved is one list of the two files and the two messages', 15000);
            await ev(framesJs(4));
            const shape = await ev(`(() => { const rows = [...document.querySelectorAll('.saved-files tbody tr')]; return { tables: document.querySelectorAll('.saved-files table, .saved-files [role="table"]').length, order: rows.map(r => r.classList.contains('inbox-file-row') ? 'file' : 'message'), inbox: rows.every(r => r.classList.contains('inbox-kind-row') && r.classList.contains('inbox-message-row')), footers: rows.map(r => !!r.querySelector(${JSON.stringify(mobile ? '.inbox-review-actions' : '.inbox-v4-footer .inbox-review-actions')})), previews: rows.map(r => !!r.querySelector('.inbox-preview')), done: rows.filter(r => r.querySelector('.inbox-saved-done')).length, heads: [...document.querySelectorAll('.inbox-saved-card .inbox-card-head')].map(h => h.textContent) }; })()`);
            check(shape.tables === 1, at + 'one table, not a files table and a messages table: ' + JSON.stringify(shape));
            check(JSON.stringify(shape.order) === JSON.stringify(['message', 'file', 'file', 'message']), at + 'newest saved first, files and messages mixed (the older message last): ' + JSON.stringify(shape.order));
            const plans = (await rowsOf0()).filter(Boolean);
            check(JSON.stringify(plans) === JSON.stringify(['plan-1', 'plan-2']), at + 'a file saved later sorts first, by saved_at not by its version time: ' + JSON.stringify(plans));
            const age = await ev(`(() => { const r = [...document.querySelectorAll('.saved-files tbody tr')].find(x => /plan-1/.test(x.textContent)); return r ? r.textContent : ''; })()`);
            check(/1 min ago/.test(age) && !/8 min ago/.test(age), at + 'the time a Saved file shows is saved_at (1 min ago), not its version time (8 min ago): ' + age.replace(/\s+/g, ' ').slice(0, 160));
            check(shape.inbox && shape.footers.every(Boolean) && shape.previews.every(Boolean), at + 'every row is an Inbox row: kind row, message row, preview, buttons under it: ' + JSON.stringify(shape));
            check(shape.done === 2 && shape.heads.length === 1, at + 'a message has Done under its words, and the list has one head: ' + JSON.stringify([shape.done, shape.heads]));
            for (const theme of ['light', 'dark']) { await setTheme(ev, theme); await ev(framesJs(3)); await shot(`saved-one-list-${w}-${theme}`); }
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('saved_one_list_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
