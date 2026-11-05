// Undo of a bulk Dismiss in Needs you while a review read is in flight (#13601): the read's lists were taken before the Undo's writes, so its answer must not be what the table shows.
// Three review files on one team, two selected and dismissed from the selection bar, the no-team read held 1.5 s, a refresh started, then the toast's Undo: the table has all three rows back.
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    const rowNames = () => ev(`[...document.querySelectorAll('${T} tbody tr')].map(r => (r.textContent.match(/bulk-0\\d/) || [''])[0])`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
            const hex = n => n.toString(16).padStart(64, '0');
            const item = i => ({ id: hex(i), name: 'bulk-0' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), produced_by: 'Writer', session_id: 's' + i });
            window.__items = [1, 2, 3].map(item); window.__ntDelay = 0;
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase();
                if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                if (u.pathname === '/api/team-artifacts') return new Promise(done => setTimeout(() => done(json({ artifacts: [], has_more: false })), window.__ntDelay || 0));
                const m = u.pathname.match(/^\\/api\\/board\\/bulk\\/artifacts(?:\\/([0-9a-f]{64})\\/review)?$/);
                if (!m) return original(url, opts);
                if (!m[1]) return json({ project: 'bulk', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                const it = window.__items.find(a => a.id === m[1]), body = opts.body ? JSON.parse(opts.body) : {};
                if (body.decision === 'ignore') it.tags = it.tags.filter(x => x !== 'for review').concat('ignored');
                if (body.decision === 'unignore') it.tags = it.tags.filter(x => x !== 'ignored').concat('for review');
                return json({ id: it.id, tags: it.tags }); }; return true; })()`);
        await ev(`fetch('/api/board/bulk/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'W' }) }).then(r => r.status)`);
        await ev(`localStorage.removeItem('coral-inbox-needs-filters'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 3`, 'three review rows', 15000);

        await ev(`[...document.querySelectorAll('${T} tbody button[role="checkbox"][aria-label^="Select "]')].slice(0, 2).forEach(b => b.click()); true`);
        await waitFor(`!!document.querySelector('.dt-bar') && /2 selected/.test(document.querySelector('.dt-bar').textContent)`, '2 selected in the bar', 8000);
        await ev(`[...document.querySelectorAll('.dt-bar button')].find(b => (b.getAttribute('aria-label') || b.textContent).trim().startsWith('Dismiss')).click(); true`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length === 1`, 'the two dismissed files leave Needs you', 10000);
        await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Dismissed 2/.test(t.textContent) && [...t.querySelectorAll('button')].some(b => b.textContent.trim() === 'Undo'))`, 'the toast says Dismissed 2, with Undo', 8000);
        await ev(`window.__ntDelay = 1500; import(${S} + 'inbox_reviews.js').then(m => { window.__inFlight = m.refreshReviews(true); return true; })`); // a read starts now: its team list is taken before the Undo, its no-team read is slow
        await ev(`[...document.querySelectorAll('.toast')].filter(t => /Dismissed 2/.test(t.textContent)).forEach(t => t.querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Undo') b.click(); })); true`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length === 3`, 'Undo with a read in flight brings both back to Needs you', 9000);
        check(JSON.stringify((await rowNames()).sort()) === JSON.stringify(['bulk-01', 'bulk-02', 'bulk-03']), 'the three files are the rows: ' + JSON.stringify(await rowNames()));
        await ev(`window.__ntDelay = 0; window.__inFlight.then(() => true)`);
    } finally { await removeBoards(ev, ['bulk']).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_bulk_dismiss_undo_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
