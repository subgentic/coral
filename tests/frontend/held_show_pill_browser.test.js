// #16649 (walk 28): the 'N new waiting. Show' pill under a resting pointer must be clickable with a real mouse: moving onto it keeps the hold (it is part of the list), and pressing Show draws the held rows and removes the pill. 1440 px, Saved table.
// A new row arrives while the pointer rests on the list (held, with the pill); the mouse then moves onto Show and clicks.
// (decisions 'ignore' and 'unignore', nothing else is posted). The server's tags are modelled in the page. 1440 and 390. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'savedact-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    const rowsOf = () => ev(`[...document.querySelectorAll('.saved-files tbody tr')].map(r => (r.textContent.match(/plan-\\d/) || [''])[0])`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 800, false]]) { // a resting pointer is a desktop thing
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = i => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'saved'], uploader: 'Plan Writer', produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?' });
                window.__items = [1, 2].map(item); window.__calls = [];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase(), m = u.pathname.match(/^\\/api\\/board\\/${team}\\/artifacts(?:\\/([0-9a-f]{64})\\/(review|tags))?$/);
                    if (method !== 'GET' && /^\\/api\\/board\\//.test(u.pathname)) window.__calls.push({ method, path: u.pathname.replace('/api/board/${team}', ''), body: opts.body ? JSON.parse(opts.body) : null });
                    if (u.pathname === '/api/team-artifacts') return new Promise(done => setTimeout(() => done(json(window.__reviewFixturePage(u,location.href,{'${team}':window.__items}))), window.__ntDelay || 0)); // the Inbox also reads the no-team list (#13574): this suite's files are all on its one team
                    if (!m) return original(url, opts);
                    if (!m[1]) return json({ project: '${team}', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    const it = window.__items.find(a => a.id === m[1]), body = opts.body ? JSON.parse(opts.body) : {};
                    if (m[2] === 'review') {
                        if (body.decision === 'ignore' && window.__refuse) return json({ message: 'refused by the test' }, 500);
                        if (body.decision === 'ignore' && window.__delay) return new Promise(done => setTimeout(() => { it.tags = it.tags.filter(x => x !== 'for review').concat('ignored'); window.__replied = Date.now(); done(json({ id: it.id, tags: it.tags })); }, window.__delay));
                        if (body.decision === 'ignore') { it.tags = it.tags.filter(x => x !== 'for review').concat('ignored'); return json({ id: it.id, tags: it.tags }); }
                        if (body.decision === 'unignore') { it.tags = it.tags.filter(x => x !== 'ignored').concat('for review'); return json({ id: it.id, tags: it.tags }); }
                        if (body.decision === 'unsave') { it.tags = it.tags.filter(x => x !== 'saved'); return json({ id: it.id, tags: it.tags }); }
                    }
                    return json({ id: it.id, tags: it.tags }); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('saved')).then(() => true)`);
            await waitFor(`!!document.querySelector('.saved-files') && document.querySelectorAll('.saved-files tbody tr').length === 2`, at + 'Saved lists the two files', 15000);
            await ev(framesJs(4));
            const rows = () => ev(`document.querySelectorAll('.saved-files tbody tr').length`);
            const mark = () => ev(`document.querySelectorAll('.saved-files tbody tr').forEach(r => { r.__kept = 1; }); true`);
            const kept = () => ev(`[...document.querySelectorAll('.saved-files tbody tr')].filter(r => r.__kept).length`);
            const rest = async () => { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 }); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the pointer leaves, so the next rest starts a fresh hold
                const p = await ev(`(() => { const r = document.querySelector('.saved-files tbody tr').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
                await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y }); await new Promise(r => setTimeout(r, 300)); }; // sleep-ok: the pointer events reach the page
            const arrive = async n => { await ev(`(() => { const hex = n => n.toString(16).padStart(64, '0'); window.__items.push({ ...window.__items[0], id: hex(${n}), name: 'plan-${n}.md', tags: ['for review', 'saved'] }); return import(${S} + 'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true); })()`); await new Promise(r => setTimeout(r, 900)); }; // sleep-ok: a redraw that was going to happen would have happened
            const heldNote = () => ev(`!!document.querySelector('#group-table-view .group-table-held')`);
            await rest(); await mark(); await arrive(3);
            check(await heldNote(), at + 'the arrival is held under the resting pointer, with the pill');
            const pos = await ev(`(() => { const b = document.querySelector('#group-table-view .group-table-held button'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b }; })()`);
            check(pos && pos.top, at + 'the Show button is what is under its own centre (not clickable through the pill): ' + JSON.stringify(pos));
            if (pos) {
                await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: pos.x, y: pos.y }); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the pointer events reach the page
                check(await heldNote(), at + 'moving onto Show keeps the pill (the pointer is still on the list)');
                await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
                await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
                await waitFor(`document.querySelectorAll('.saved-files tbody tr').length === 3`, at + 'pressing Show draws the held row', 5000).catch(e => failures.push(e.message.slice(0, 200)));
                check(!(await heldNote()), at + 'the pill is gone after Show');
            }
        }
    } finally { try { await removeBoards(ev, [team]); } catch (e) {} await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the Show pill works with a real mouse');
})().catch(e => { console.error(e); process.exit(1); });
