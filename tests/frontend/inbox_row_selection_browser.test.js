// Needs you rows keep opening after a live refresh (#11584, the operator on the desktop app v2.0.18: items stop opening after the Inbox refreshes while they are on the screen, and blue bars appear between the cells like a
// drop indicator). The bars are a text selection across the table's cells: a web view (macOS WKWebView) treats a click on a selection as the start of a drag of it and the click never opens the row, and a redraw leaves the
// selection on nodes that are gone, so nothing clears it. A row that opens on a click is not text to select (its cells are not selectable), and drawing the list again clears a selection inside it. A real mouse
// click opens the row after a selection and a redraw. Stubbed review rows, 1440. Drives Chrome through agent_view_harness.js against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
            const hex = n => n.toString(16).padStart(64, '0');
            const item = i => ({ id: hex(i), name: 'plan-0' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), produced_by: 'Writer', session_id: 's' + i });
            window.__items = [1, 2, 3].map(item);
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                if (!/^\\/api\\/board\\/sel\\/artifacts$/.test(u.pathname)) return original(url, opts);
                return json({ project: 'sel', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false }); }; return true; })()`);
        await ev(`fetch('/api/board/sel/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'W' }) }).then(r => r.status)`);
        await ev(`localStorage.removeItem('coral-inbox-needs-filters'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 3`, 'three review rows', 15000);

        // a row that opens on a click is not selectable
        const sel = await ev(`(() => { const td = document.querySelector('${T} tbody tr td'); const cs = getComputedStyle(td); return { userSelect: cs.userSelect || cs.webkitUserSelect, row: getComputedStyle(td.parentElement).userSelect }; })()`);
        check(sel.userSelect === 'none' && sel.row === 'none', 'the cells of a row that opens on a click are not text to select: ' + JSON.stringify(sel));

        // a selection across the cells (a drag that went over them, or a select-all) is cleared when the list is drawn again
        await ev(`(() => { const s = getSelection(), body = document.querySelector('${T} tbody'); s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(body); s.addRange(r); return true; })()`);
        await ev(`(() => { window.__items = window.__items.slice(1); return import(${S} + 'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true); })()`); // an item has been dealt with elsewhere: the list is drawn again with two rows
        await waitFor(`document.querySelectorAll('${T} tbody tr').length === 2`, 'the list is drawn again with two rows', 10000);
        await ev(framesJs(6));
        const kept = await ev(`(() => { const s = getSelection(); return { collapsed: s.isCollapsed, text: String(s).length, inTable: !!(s.anchorNode && document.querySelector('${T}').contains(s.anchorNode)) }; })()`);
        check(kept.collapsed || !kept.inTable, 'after the list is drawn again no selection is left inside it: ' + JSON.stringify(kept));

        // and a real click opens the row
        const r = await ev(`(() => { const b = document.querySelector('${T} tbody tr .inbox-review-name').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: r.x, y: r.y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
        await ev(framesJs(10));
        check(await ev(`!!document.querySelector('.artifact-viewer-close, .artifact-viewer')`), 'a real click on the row opens it after the selection and the redraw');
    } finally { await removeBoards(ev, ['sel']).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_row_selection_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
