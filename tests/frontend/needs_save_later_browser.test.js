// Save for later on a Needs you review row (#11641, the operator): the row's three dots have "Save for later" (and a row can be dragged onto Saved): the file leaves Needs you and its count, a toast offers Undo, Saved lists it
// under Saved as a calm row (#22108: no verdict buttons, "To review" as its tag), and "Remove from Saved" brings it back as it was. Each is one decision on the review route ('save', 'unsave') and nothing else is posted
// (nothing is sent to the agent). The server's tags are modelled in the page. 1440 and 390. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'later-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    const rowsOf = () => ev(`[...document.querySelectorAll('${T} tbody tr')].map(r => (r.textContent.match(/plan-\\d/) || [''])[0])`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile] of [[1440, 800, false], [390, 800, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = i => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], uploader: 'Plan Writer', produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?' });
                window.__items = [1, 2, 3].map(item); window.__calls = [];
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': window.__items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase(), m = u.pathname.match(/^\\/api\\/board\\/${team}\\/artifacts(?:\\/([0-9a-f]{64})\\/(review|tags))?$/);
                    if (method !== 'GET' && /^\\/api\\/board\\//.test(u.pathname)) window.__calls.push({ method, path: u.pathname.replace('/api/board/${team}', ''), body: opts.body ? JSON.parse(opts.body) : null });
                    if (!m) return original(url, opts);
                    if (!m[1]) return json({ project: '${team}', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    const it = window.__items.find(a => a.id === m[1]), body = opts.body ? JSON.parse(opts.body) : {};
                    if (m[2] === 'review') {
                        const strip = t => it.tags.filter(x => x !== t);
                        if (body.decision === 'save') { it.tags = it.tags.includes('saved') ? it.tags : it.tags.concat('saved'); return json({ id: it.id, delivered: false, tags: it.tags }); }
                        if (body.decision === 'unsave') { it.tags = strip('saved'); return json({ id: it.id, delivered: false, tags: it.tags }); }
                        it.tags = strip('saved').filter(x => x !== 'for review').concat(body.decision === 'deny' ? 'denied' : 'approved'); return json({ id: it.id, state: body.decision, delivered: true, to: 'Plan Writer' });
                    }
                    return json({ id: it.id, tags: it.tags }); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 3`, at + 'three review rows', 15000);
            await ev(framesJs(3));
            const dots = file => ev(`(() => { document.querySelector('${T} button[aria-label="More actions for ${file}"]').click(); return true; })()`);
            // the three dots: Save for later
            { // Save stays separate from the star at both widths (#20203).
                check(await ev(`!!document.querySelector('${T} .dt-star') && !!document.querySelector('${T} button.inbox-bookmark[aria-label="Save for later: plan-1.md"]')`), at + 'the row has separate Save for later and review star controls');
                { const order = await ev(`[...document.querySelector('${T} .inbox-review-actions').querySelectorAll('button')].filter(e => e.getClientRects().length).map(e => e.matches('.inbox-row-more-toggle') ? 'More' : e.classList.contains('dt-star') ? 'Star' : e.classList.contains('inbox-bookmark') ? 'Save' : e.textContent.trim() || e.getAttribute('aria-label'))`); check(order[order.length - 1] === 'More' && order.indexOf('Star') < order.indexOf('More'), at + 'the row ends Star, then More (#20239): ' + JSON.stringify(order)); }
                await ev(`document.querySelector('${T} button.inbox-bookmark[aria-label="Save for later: plan-1.md"]').click(); true`);
            }
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 2`, at + 'the saved row leaves Needs you', 8000);
            check(JSON.stringify(await rowsOf()) === JSON.stringify(['plan-2', 'plan-3']), at + 'the others stay: ' + JSON.stringify(await rowsOf()));
            let calls = await ev(`window.__calls`);
            check(calls.length === 1 && calls[0].path.endsWith('/review') && calls[0].body.decision === 'save', at + 'one decision, "save", and nothing else was posted: ' + JSON.stringify(calls));
            check(await ev(`[...document.querySelectorAll('.toast')].some(t => /Saved for later: plan-1\\.md/.test(t.textContent) && [...t.querySelectorAll('button')].some(b => b.textContent.trim() === 'Undo'))`), at + 'a toast says it, with Undo');
            // Saved lists it as a calm row (#22108): no Approve or Request changes on the row, the verdict is given in the file; "To review" says one is still owed
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('saved')).then(() => true)`);
            await waitFor(`!!document.querySelector('.saved-ledger') && document.querySelector('.saved-ledger').textContent.includes('plan-1.md')`, at + 'Saved lists the file', 10000);
            const row = await ev(`(() => { const r = [...document.querySelectorAll('.saved-ledger .sl-row')].find(e => e.textContent.includes('plan-1.md')); if (!r) return null; return { text: r.textContent.replace(/\\s+/g, ' '), tag: (r.querySelector('.sl-tag') || {}).textContent || '', agent: (r.querySelector('.sl-avatar') || {}).title || r.textContent, names: [...r.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent).trim()) }; })()`);
            check(!!row, at + 'the saved file has a row');
            if (row) {
                check(mobile || /Ship plan 1\?/.test(row.text), at + 'the file\'s question is on line 2, read from review_question as Needs you does: ' + row.text);
                check(/Plan Writer/.test(row.agent), at + 'the sender is the row\'s agent, read from produced_by: ' + JSON.stringify(row.agent));
                check(row.tag === 'To review', at + 'the tag says "To review": ' + JSON.stringify(row.tag));
                check(!row.names.some(n => /^(Approve|Request changes|Deny|Comment):/.test(n)), at + 'no verdict buttons on the row: ' + JSON.stringify(row.names));
            }
            // the count is said once: the title on a phone, the line above the list on a desktop; the Open pill has no number
            const counts = await ev(`({ line: (document.querySelector('.saved-ledger-count') || {}).textContent || '', title: (document.querySelector('.inbox-folder-head') || {}).textContent || '', pill: [...document.querySelectorAll('button')].filter(b => /^Open\\b/.test(b.textContent.trim()) && b.closest('.inbox-folder-toolbar')).map(b => b.textContent.trim()) })`);
            check(!mobile ? /^1 saved\b/.test(counts.line.trim()) : /1/.test(counts.title), at + 'the count includes the saved file: ' + JSON.stringify(counts));
            check(counts.pill.every(p => p === 'Open'), at + 'the Open pill carries no number: ' + JSON.stringify(counts.pill));
            await shot(`saved-files-${w}`);
            // Remove from Saved: back to Needs you (on a desktop the row's button, on a phone the row's "..." menu)
            if (!mobile) await ev(`document.querySelector('.saved-ledger button[aria-label="Remove from Saved: plan-1.md"]').click(); true`);
            else { await ev(`document.querySelector('.saved-ledger button[aria-label="More actions for plan-1.md"]').click(); true`); await waitFor(`!!document.querySelector('.menu-item[aria-label="Remove from Saved: plan-1.md"]')`, at + 'the menu has "Remove from Saved"', 5000); await ev(`document.querySelector('.menu-item[aria-label="Remove from Saved: plan-1.md"]').click(); true`); }
            await waitFor(`!document.querySelector('.saved-ledger') || !document.querySelector('.saved-ledger').textContent.includes('plan-1.md')`, at + 'it leaves Saved', 8000);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 3`, at + 'it is back in Needs you', 10000);
            calls = await ev(`window.__calls`);
            check(calls.length === 2 && calls[1].body.decision === 'unsave', at + 'the second decision is "unsave", nothing else: ' + JSON.stringify(calls.map(c => c.body)));
            // drag onto Saved (a desktop's gesture)
            if (!mobile) {
                await ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => /plan-2/.test(r.textContent)), dt = new DataTransfer(), saved = document.querySelector('.view-list-item[data-key="saved"]');
                    tr.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); saved.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })); saved.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
                await waitFor(`[...document.querySelectorAll('${T} tbody tr')].every(r => !/plan-2/.test(r.textContent))`, at + 'a row dragged onto Saved is saved', 8000);
                calls = await ev(`window.__calls`);
                check(calls.length === 3 && calls[2].body.decision === 'save', at + 'the drop is one "save" decision: ' + JSON.stringify(calls.map(c => c.body)));
            }
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_save_later_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
