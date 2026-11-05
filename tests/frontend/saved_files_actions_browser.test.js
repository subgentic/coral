// The Saved folder's "Files for review" rows have the same actions as a Needs you row (#11799, the operator: they had Approve, Changes and Deny but no Dismiss): Approve, a Request changes icon and the three dots in their fixed slots (Dismiss and Deny are in the dots, #12231), the three dots with
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
                    if (u.pathname === '/api/team-artifacts') return json({ artifacts: [], has_more: false }); // the Inbox also reads the no-team list (#13574): this suite's files are all on its one team
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
            await waitFor(`!!document.querySelector('.saved-files') && document.querySelectorAll('.saved-files tbody tr').length === 2`, at + 'Saved lists the two files', 15000);
            await ev(framesJs(4));
            if (!mobile) { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 }); await ev(framesJs(3)); }
            // the row's actions: the same set and slots as a Needs you row
            const shape = await ev(`(() => { const box = document.querySelector('.saved-files tbody tr .inbox-review-actions'), names = [...box.querySelectorAll('button')].map(b => (b.getAttribute('data-slot') || b.getAttribute('aria-label'))); return { slots: [...box.children].map(c => c.getAttribute('data-slot')).filter(Boolean), hover: !!box.closest('.inbox-actions-hover'), opacity: Number(getComputedStyle(box).opacity), names }; })()`);
            check(JSON.stringify(shape.slots) === JSON.stringify(mobile ? ['approve', 'changes', 'dots'] : ['approve', 'changes', 'dots'] /* option B (#12231): Deny and Dismiss are in the dots on every width */), at + 'the buttons are in Needs you\'s slots: ' + JSON.stringify(shape.slots));
            if (!mobile) {
                check(shape.hover && shape.opacity === 0, at + 'with a mouse the buttons show only at the row\'s hover (Needs you\'s rule): ' + JSON.stringify([shape.hover, shape.opacity]));
                const at1 = await ev(`(() => { const r = document.querySelector('.saved-files tbody tr').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
                await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: at1.x, y: at1.y }); await ev(framesJs(3));
                check(await ev(`Number(getComputedStyle(document.querySelector('.saved-files tbody tr .inbox-review-actions')).opacity) === 1`), at + 'the buttons show while the row is hovered');
            }
            await shot(`saved-actions-${w}`);
            // the dots
            await ev(`document.querySelector('.saved-files button[aria-label="More actions for plan-1.md"]').click(); true`);
            await waitFor(`!!document.querySelector('.saved-files .menu:not([hidden]) .menu-item')`, at + 'the dots open', 5000);
            const items = await ev(`[...document.querySelectorAll('.saved-files .menu:not([hidden]) .menu-item')].map(x => x.textContent.trim())`);
            check(JSON.stringify(items) === JSON.stringify(['Approve with a note', 'Dismiss', 'Deny', 'Move to Needs you']), at + 'the dots hold: ' + JSON.stringify(items));
            await ev(`document.querySelector('.saved-files button[aria-label="More actions for plan-1.md"]').click(); true`); await new Promise(r => setTimeout(r, 250)); // sleep-ok: the menu closes (the same button again)
            // Dismiss: out of Saved, with a toast and Undo
            if (!mobile) await ev(`document.querySelector('.saved-files button[aria-label="Dismiss: plan-1.md"]').click(); true`);
            else { await ev(`document.querySelector('.saved-files button[aria-label="More actions for plan-1.md"]').click(); true`); await waitFor(`!!document.querySelector('.saved-files .menu-item[aria-label="Dismiss: plan-1.md"]')`, at + 'the dots have Dismiss', 5000); await ev(`document.querySelector('.saved-files .menu-item[aria-label="Dismiss: plan-1.md"]').click(); true`); }
            await waitFor(`document.querySelectorAll('.saved-files tbody tr').length === 1`, at + 'the ignored file leaves Saved', 8000);
            check(JSON.stringify(await rowsOf()) === JSON.stringify(['plan-2']), at + 'the other stays: ' + JSON.stringify(await rowsOf()));
            let calls = await ev(`window.__calls`);
            check(calls.length === 1 && calls[0].path.endsWith('/review') && calls[0].body.decision === 'ignore', at + 'one decision, "ignore", and nothing else was posted: ' + JSON.stringify(calls));
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Dismissed: plan-1\\.md/.test(t.textContent) && [...t.querySelectorAll('button')].some(b => b.textContent.trim() === 'Undo'))`, at + 'a toast says it, with Undo', 8000);
            await ev(`[...document.querySelectorAll('.toast')].find(t => /Dismissed: plan-1\\.md/.test(t.textContent)).querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Undo') b.click(); }); true`);
            await waitFor(`document.querySelectorAll('.saved-files tbody tr').length === 2`, at + 'Undo brings it back to Saved', 8000);
            calls = await ev(`window.__calls`);
            check(calls.length === 2 && calls[1].body.decision === 'unignore', at + 'Undo is one "unignore": ' + JSON.stringify(calls));
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('saved_files_actions_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
