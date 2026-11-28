// The Saved page's file rows (#22108, the Saved mock of task #22107): no Approve or Request changes on the row (the verdict is given in the file, as in Needs you); with a mouse, Remove from Saved, Star and
// More show at the row's hover, More holding Copy version ID and Dismiss; a phone has one 44x44 menu with Open and the rest. Dismiss takes the file out of Saved with a toast and Undo, and Undo brings it back
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
    const rowsOf = () => ev(`[...document.querySelectorAll('.saved-ledger .sl-row')].map(r => (r.textContent.match(/plan-\\d/) || [''])[0])`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 800, false], [390, 800, true]]) {
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
                        if (body.decision === 'ignore') { it.tags = it.tags.filter(x => x !== 'for review').concat('ignored'); return json({ id: it.id, tags: it.tags }); }
                        if (body.decision === 'unignore') { it.tags = it.tags.filter(x => x !== 'ignored').concat('for review'); return json({ id: it.id, tags: it.tags }); }
                        if (body.decision === 'unsave') { it.tags = it.tags.filter(x => x !== 'saved'); return json({ id: it.id, tags: it.tags }); }
                    }
                    return json({ id: it.id, tags: it.tags }); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('saved')).then(() => true)`);
            await waitFor(`!!document.querySelector('.saved-ledger') && document.querySelectorAll('.saved-ledger .sl-row').length === 2`, at + 'Saved lists the two files', 15000);
            await ev(framesJs(4));
            if (!mobile) { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 }); await ev(framesJs(3)); }
            // the row (#22108, the Saved mock): no buttons at rest; with the pointer on it, Remove from Saved, Star and More take the right side's place; a phone has one 44x44 "..." menu
            const row = `[...document.querySelectorAll('.saved-ledger .sl-row')].find(r => /plan-1\\.md/.test(r.textContent))`; // plan-2 is newer, so it is first (newest saved first)
            const rest = await ev(`(() => { const r = ${row}; return { tag: r.querySelector('.sl-tag')?.textContent, actions: getComputedStyle(r.querySelector('.sl-actions')).display, approve: !!r.querySelector('[data-slot="approve"], .inbox-approve-action') }; })()`);
            check(rest.tag === 'To review' && !rest.approve, at + 'the row says To review and has no Approve: ' + JSON.stringify(rest));
            if (!mobile) {
                check(rest.actions === 'none', at + 'no buttons at rest: ' + rest.actions);
                const at1 = await ev(`(() => { const r = ${row}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
                await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: at1.x, y: at1.y }); await ev(framesJs(3));
                const hover = await ev(`(() => { const r = ${row}; return { shown: getComputedStyle(r.querySelector('.sl-actions')).display, names: [...r.querySelectorAll('.sl-actions > button, .sl-actions .inbox-row-more-toggle')].map(b => b.getAttribute('aria-label')), right: getComputedStyle(r.querySelector('.sl-right')).visibility === 'hidden' ? 'none' : 'shown' }; })()`);
                check(hover.shown === 'flex' && hover.right === 'none' && JSON.stringify(hover.names) === JSON.stringify(['Remove from Saved: plan-1.md', 'Star: plan-1.md', 'More actions for plan-1.md']), at + 'on hover the actions take the right side\'s place: ' + JSON.stringify(hover));
            } else {
                const dots = await ev(`(() => { const b = ${row}.querySelector('.inbox-row-more-toggle'), r = b.getBoundingClientRect(); return { w: r.width, h: r.height, label: b.getAttribute('aria-label') }; })()`);
                check(dots.w >= 44 && dots.h >= 44 && dots.label === 'More actions for plan-1.md', at + 'a phone row has a 44x44 menu: ' + JSON.stringify(dots));
            }
            await shot(`saved-actions-${w}`);
            // the dots
            await ev(`document.querySelector('.saved-ledger button[aria-label="More actions for plan-1.md"]').click(); true`);
            await waitFor(`!!document.querySelector('.saved-ledger .menu:not([hidden]) .menu-item')`, at + 'the dots open', 5000);
            const items = await ev(`[...document.querySelectorAll('.saved-ledger .menu:not([hidden]) .menu-item')].map(x => x.textContent.trim())`);
            check(JSON.stringify(items) === JSON.stringify(mobile ? ['Open', 'Remove from Saved', 'Star', 'Copy version ID', 'Dismiss'] : ['Copy version ID', 'Dismiss']), at + 'the dots hold: ' + JSON.stringify(items));
            await ev(`document.querySelector('.saved-ledger button[aria-label="More actions for plan-1.md"]').click(); true`); await new Promise(r => setTimeout(r, 250)); // sleep-ok: the menu closes (the same button again)
            // Dismiss: out of Saved, with a toast and Undo
            { await ev(`document.querySelector('.saved-ledger button[aria-label="More actions for plan-1.md"]').click(); true`); await waitFor(`!!document.querySelector('.saved-ledger .menu-item[aria-label="Dismiss: plan-1.md"]')`, at + 'the dots have Dismiss', 5000); await ev(`document.querySelector('.saved-ledger .menu-item[aria-label="Dismiss: plan-1.md"]').click(); true`); }
            await waitFor(`document.querySelectorAll('.saved-ledger .sl-row').length === 1`, at + 'the ignored file leaves Saved', 8000);
            check(JSON.stringify(await rowsOf()) === JSON.stringify(['plan-2']), at + 'the other stays: ' + JSON.stringify(await rowsOf()));
            let calls = await ev(`window.__calls`);
            check(calls.length === 1 && calls[0].path.endsWith('/review') && calls[0].body.decision === 'ignore', at + 'one decision, "ignore", and nothing else was posted: ' + JSON.stringify(calls));
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Dismissed: plan-1\\.md/.test(t.textContent) && [...t.querySelectorAll('button')].some(b => b.textContent.trim() === 'Undo'))`, at + 'a toast says it, with Undo', 8000);
            await ev(`[...document.querySelectorAll('.toast')].find(t => /Dismissed: plan-1\\.md/.test(t.textContent)).querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Undo') b.click(); }); true`);
            await waitFor(`document.querySelectorAll('.saved-ledger .sl-row').length === 2`, at + 'Undo brings it back to Saved', 8000);
            calls = await ev(`window.__calls`);
            check(calls.length === 2 && calls[1].body.decision === 'unignore', at + 'Undo is one "unignore": ' + JSON.stringify(calls));
            // A read already in flight when Undo lands (the no-team read is slow, #13601): its team list was taken before the Undo's write, so it must not be the answer Saved shows
            await ev(`window.__ntDelay = 1500; true`);
            await ev(`document.querySelector('.saved-ledger button[aria-label="More actions for plan-1.md"]').click(); true`);
            await waitFor(`!!document.querySelector('.saved-ledger .menu-item[aria-label="Dismiss: plan-1.md"]')`, at + 'the dots have Dismiss (second time)', 5000);
            await ev(`document.querySelector('.saved-ledger .menu-item[aria-label="Dismiss: plan-1.md"]').click(); true`);
            await waitFor(`document.querySelectorAll('.saved-ledger .sl-row').length === 1`, at + 'the second Dismiss leaves Saved', 8000);
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Dismissed: plan-1\\.md/.test(t.textContent) && [...t.querySelectorAll('button')].some(b => b.textContent.trim() === 'Undo'))`, at + 'the second toast, with Undo', 8000);
            await ev(`import(${S} + 'inbox_reviews.js').then(m => { window.__inFlight = m.refreshReviews(true); return true; })`); // a refresh starts now and is held by the slow read
            await ev(`[...document.querySelectorAll('.toast')].filter(t => /Dismissed: plan-1\\.md/.test(t.textContent)).forEach(t => t.querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Undo') b.click(); })); true`);
            await waitFor(`document.querySelectorAll('.saved-ledger .sl-row').length === 2`, at + 'Undo during a read in flight still brings it back to Saved', 8000);
            await ev(`window.__ntDelay = 0; window.__inFlight.then(() => true)`);
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('saved_files_actions_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
