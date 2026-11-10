// #14373 (UI Reviewer's narrower rule): under a RESTING pointer a table's redraw is held (#14173), but the result of the person's own completed action is not. A refused Dismiss, the ⋯ menu opening and closing release nothing: an unrelated new row stays held; a Dismiss whose answer takes 6.5 s (past any time window) leaves its row at once when it succeeds. 1440 px.
// "Move to Needs you"; with a mouse the buttons show at the row's hover (Needs you's rule, #11669), a phone has Deny and Dismiss in the dots. Dismiss takes the file out of Saved with a toast and Undo, and Undo brings it back
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
            await rest(); await mark();
            // 1) the dots open and close: nothing is released
            await ev(`document.querySelector('.saved-files button[aria-label="More actions for plan-1.md"]').click(); true`);
            await waitFor(`!!document.querySelector('.saved-files .menu:not([hidden]) .menu-item')`, at + 'the dots open', 5000);
            await ev(`document.querySelector('.saved-files button[aria-label="More actions for plan-1.md"]').click(); true`); await new Promise(r => setTimeout(r, 250)); // sleep-ok: the menu closes
            // 2) a REFUSED Dismiss: an error, the row stays, and nothing is released
            await ev(`window.__refuse = true; document.querySelector('.saved-files button[aria-label="Dismiss: plan-1.md"]').click(); true`);
            await waitFor(`!!(document.querySelector('.saved-files .inbox-review-error') || {}).textContent`, at + 'a refused Dismiss says why', 8000);
            await arrive(3);
            check(await rows() === 2 && await kept() === 2 && await heldNote(), at + 'after the menu and a refused Dismiss an unrelated new row is still held (rows ' + await rows() + ', kept ' + await kept() + ', note ' + await heldNote() + ')');
            { // the held note must not sit over a row's buttons (#15142): More, Download and Open were clipped by the full-width bar, and a click on them hit the bar
                const cover = await ev(`(() => { const n = document.querySelector('#group-table-view .group-table-held'); if (!n) return null; const a = n.getBoundingClientRect(); const hit = [...document.querySelectorAll('.saved-files tbody tr button')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left < a.right && r.right > a.left && r.top < a.bottom && r.bottom > a.top; }).map(b => b.getAttribute('aria-label')); return { hit, events: getComputedStyle(n).pointerEvents, w: Math.round(a.width), vw: innerWidth }; })()`);
                check(cover && cover.hit.length === 0 && cover.events === 'none' && cover.w < cover.vw * 0.9, at + 'the held note covers no row button and lets a click through: ' + JSON.stringify(cover));
            }
            // 3) a Dismiss that is accepted after 6.5 s: the row leaves at once when it is, not up to 10 s later
            await ev(`window.__refuse = false; window.__delay = 6500; true`);
            await rest(); await mark();
            await ev(`document.querySelector('.saved-files button[aria-label="Dismiss: plan-1.md"]').click(); true`);
            await waitFor(`!!window.__replied`, at + 'the slow answer came', 12000);
            const t0 = Date.now();
            await waitFor(`document.querySelectorAll('.saved-files tbody tr').length === 2 && ![...document.querySelectorAll('.saved-files tbody tr')].some(r => /plan-1\\.md/.test(r.textContent))`, at + 'the dismissed row leaves after the slow success', 10000);
            check(Date.now() - t0 < 2500, at + 'it left within 2.5 s of the answer (took ' + (Date.now() - t0) + ' ms), though the pointer rests and the answer came after 6.5 s');
            // 4) the person goes ELSEWHERE while a Dismiss is slow, and comes back to a fresh Saved: the late success is for the table it began in, not this one
            await ev(`window.__replied = 0; window.__delay = 6500; true`);
            await rest(); await mark();
            await ev(`document.querySelector('.saved-files button[aria-label^="Dismiss: plan-"]').click(); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the other table is drawn
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('saved')).then(() => true)`);
            await waitFor(`!!document.querySelector('.saved-files') && document.querySelectorAll('.saved-files tbody tr').length >= 2`, at + 'Saved is drawn again (a new table)', 10000);
            await rest(); await mark(); await arrive(4); // a new row arrives in the NEW table, held under the resting pointer
            const before = await rows();
            await waitFor(`!!window.__replied`, at + 'the slow answer of the first table came', 12000);
            await new Promise(r => setTimeout(r, 1200)); // sleep-ok: a redraw the late answer wrongly asked for would have happened by now
            check(await rows() === before && await kept() === before && await heldNote(), at + 'the late answer of the table the person left did not release this one: rows ' + before + ' -> ' + await rows() + ', kept ' + await kept() + ', note ' + await heldNote());
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('table_hold_actions_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
