// Save for later on a Needs you review row (#11641, the operator): the row's three dots have "Save for later" (and a row can be dragged onto Saved): the file leaves Needs you and its count, a toast offers Undo, Saved lists it
// under "Files for review" with Approve, Changes and Deny still there and "Move to Needs you" in its dots, which brings it back as it was. Each is one decision on the review route ('save', 'unsave') and nothing else is posted
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
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase(), m = u.pathname.match(/^\\/api\\/board\\/${team}\\/artifacts(?:\\/([0-9a-f]{64})\\/(review|tags))?$/);
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
            await dots('plan-1.md');
            await waitFor(`!!document.querySelector('${T} .menu-item[aria-label="Save for later: plan-1.md"]')`, at + 'the dots have "Save for later"', 5000);
            await ev(`document.querySelector('${T} .menu-item[aria-label="Save for later: plan-1.md"]').click(); true`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 2`, at + 'the saved row leaves Needs you', 8000);
            check(JSON.stringify(await rowsOf()) === JSON.stringify(['plan-2', 'plan-3']), at + 'the others stay: ' + JSON.stringify(await rowsOf()));
            let calls = await ev(`window.__calls`);
            check(calls.length === 1 && calls[0].path.endsWith('/review') && calls[0].body.decision === 'save', at + 'one decision, "save", and nothing else was posted: ' + JSON.stringify(calls));
            check(await ev(`[...document.querySelectorAll('.toast')].some(t => /Saved for later: plan-1\\.md/.test(t.textContent) && [...t.querySelectorAll('button')].some(b => b.textContent.trim() === 'Undo'))`), at + 'a toast says it, with Undo');
            // Saved lists it, with its decisions
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('saved')).then(() => true)`);
            await waitFor(`!!document.querySelector('.saved-files') && document.querySelector('.saved-files').textContent.includes('plan-1.md')`, at + 'Saved lists the file under "Files for review"', 10000);
            check(await ev(`/Ship plan 1\\? .{1,3} from Plan Writer/.test(document.querySelector('.saved-files').textContent.replace(/\\s+/g, ' '))`), at + 'the file\'s question and sender are shown, read from review_question and produced_by as Needs you does');
            const sec = await ev(`(() => { const s = document.querySelector('.saved-files'); const names = [...s.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent).trim()); return { title: (s.querySelector('.saved-files-title') || {}).textContent, names }; })()`);
            check(sec.title === 'Files for review', at + 'the section is "Files for review": ' + JSON.stringify(sec.title));
            check(['Approve: plan-1.md', 'Request changes: plan-1.md'].every(n => sec.names.includes(n)) && sec.names.some(n => /^(Deny: plan-1\.md|More actions for plan-1\.md)$/.test(n)), at + 'Approve, Changes and Deny are still there: ' + JSON.stringify(sec.names));
            const counts = await ev(`({ title: (document.querySelector('.group-table-title, .inbox-group-title, h2') || {}).textContent, pill: [...document.querySelectorAll('button')].filter(b => /^Open \\d/.test(b.textContent.trim())).map(b => b.textContent.trim()), side: (document.querySelector('.view-list-item[data-key="saved"]') || {}).textContent })`);
            check(!mobile ? /^Open 1$/.test((counts.pill || [])[0] || '') : true, at + 'the Open pill counts the saved file: ' + JSON.stringify(counts));
            check(/Saved\s*1/.test(String(counts.title).replace(/\s+/g, ' ')) || !!(await ev(`/Saved\\s*1\\b/.test(document.querySelector('#inbox-page, #group-table-view')?.closest('main, section, div')?.textContent.slice(0, 400) || document.body.textContent.slice(0, 600))`)), at + 'the title count includes the saved file: ' + JSON.stringify(counts));
            await shot(`saved-files-${w}`);
            // Move to Needs you
            await ev(`document.querySelector('.saved-files button[aria-label="More actions for plan-1.md"]').click(); true`);
            await waitFor(`!!document.querySelector('.saved-files .menu-item[aria-label="Move to Needs you: plan-1.md"]')`, at + 'the dots have "Move to Needs you"', 5000);
            await ev(`document.querySelector('.saved-files .menu-item[aria-label="Move to Needs you: plan-1.md"]').click(); true`);
            await waitFor(`!document.querySelector('.saved-files') || !document.querySelector('.saved-files').textContent.includes('plan-1.md')`, at + 'it leaves Saved', 8000);
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
