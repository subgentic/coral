// Needs you's review rows keep all their actions whole whatever width was saved for the Actions column (#9845, QA Engineer's gap 1): the real wiring, the Inbox's Needs you table with a read review artifact (Open, Mark unread, Mark reviewed)
// and a narrow width kept in this browser for the review column. The column is fixed (inbox_sidebar.js: fixed: true), so the kept width is ignored: it is its 21 rem (a read row's three buttons and its star) and every button is inside its cell and inside the table. 1280 px, the team through the real board API,
// the artifact list stubbed as the server answers. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'needs-width-' + Date.now().toString(36);
    const row = name => `[...document.querySelectorAll('#group-table-view tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(name)}))`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
        assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer',job_title:'Writer'})}).then(r=>r.status)`), 200);
        await ev(`(() => {
            localStorage.removeItem('coral-inbox-needs-filters');
            // a width kept for the review column when it had fewer buttons, and the table's label is its key ("Needs you, 3" is the list "Needs you")
            localStorage.setItem('coral-dt-widths:Needs you', JSON.stringify({ review: 150 }));
            const mk = (n, tags) => ({ id: n.toString(16).padStart(64, '0'), name: 'Review file 0' + n + '.txt', media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - (10 - n) * 60000).toISOString(), tags, available: true, uri: 'coral://artifacts/' + n.toString(16).padStart(64, '0'), produced_by: 'Review Writer', session_id: 'rw-1', task_id: n });
            window.__reviewItems = [mk(1, ['for review']), mk(2, ['for review', 'read']), mk(3, ['for review'])];
            const original = window.fetch, json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                if (u.pathname === '/api/board/${team}/artifacts') { const items = window.__reviewItems.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))); return json({ project: '${team}', artifacts: items, has_more: false }); }
                return original(url, opts); };
            return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
        await waitFor(`!!(${row('Review file 02.txt')})`, 'the review rows in Needs you', 15000);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the table settles after its first draw
        const m = await ev(`(() => { const r = ${row('Review file 02.txt')}, td = r.querySelector('td[data-key="review"]'), th = document.querySelector('#group-table-view th[data-key="review"]'), box = document.querySelector('#group-table-view .dt-box').getBoundingClientRect(), bs = [...td.querySelectorAll('.inbox-review-actions button')].map(b => ({ label: b.getAttribute('aria-label'), r: Math.round(b.getBoundingClientRect().right), w: Math.round(b.getBoundingClientRect().width) }));
            return { buttons: bs.map(b => b.label), lastRight: Math.max(...bs.map(b => b.r)), tdRight: Math.round(td.getBoundingClientRect().right), boxRight: Math.round(box.right), thW: Math.round(th.getBoundingClientRect().width), handle: !!th.querySelector('.dt-resize'), clipped: td.scrollWidth > td.clientWidth + 1, kept: localStorage.getItem('coral-dt-widths:Needs you') }; })()`);
        assert.deepEqual(m.buttons, ['Star Review file 02.txt', 'Open Review file 02.txt', 'Mark unread: Review file 02.txt', 'Mark reviewed: Review file 02.txt'], 'a read review row has its star and its three actions (the star #9834): ' + JSON.stringify(m));
        assert.ok(Math.abs(m.thW - 336) <= 3 && !m.handle, 'the Actions column is its declared 21 rem (19 and 2 for the star, #9834; not the 150 px kept for it) and has no handle: ' + JSON.stringify(m));
        assert.ok(m.lastRight <= m.tdRight + 1 && m.lastRight <= m.boxRight && !m.clipped, 'all three buttons are whole, inside the cell and inside the table: ' + JSON.stringify(m));
        // the Operator's #10443: the last column's right edge dragged in from the right. The box drops Team and the others it has no room for; their <col>s must go with them, or every width after
        // lands on the wrong column (Actions squeezed to 64 px, its buttons cut) and the table ends short of the card.
        const keys = await ev(`[...document.querySelectorAll('#group-table-view thead th')].filter(t => t.getBoundingClientRect().width > 0).map(t => t.dataset.key)`);
        const last = keys[keys.length - 1];
        const h = await ev(`(() => { const r = document.querySelector('#group-table-view th[data-key="${last}"] .dt-resize').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
        const mouse = (type, x, y) => client.Input.dispatchMouseEvent({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
        await mouse('mouseMoved', h.x, h.y); await mouse('mousePressed', h.x, h.y); for (let k = 1; k <= 8; k++) await mouse('mouseMoved', h.x - 40 * k, h.y); await mouse('mouseReleased', h.x - 320, h.y);
        await new Promise(r => setTimeout(r, 400)); // sleep-ok: the settle after the drag
        const d = await ev(`(() => { const b = document.querySelector('#group-table-view .dt-box'), t = b.querySelector('table'), th = k => b.querySelector('th[data-key="' + k + '"]'); return { review: Math.round(th('review').getBoundingClientRect().width), table: Math.round(t.getBoundingClientRect().width), box: b.clientWidth, last: Math.round(th(${JSON.stringify(last)}).getBoundingClientRect().right), boxRight: Math.round(b.getBoundingClientRect().right), buttonsWhole: [...document.querySelectorAll('#group-table-view td[data-key="review"] button')].every(x => x.getBoundingClientRect().right <= th('review').getBoundingClientRect().right + 1) }; })()`);
        assert.ok(d.review >= 200 && d.buttonsWhole, 'dragging the last column leaves the Actions column its width and its buttons whole: ' + JSON.stringify(d));
        assert.ok(d.table >= d.box - 1, 'the table is not short of its card: ' + JSON.stringify(d));
        console.log('PASS Needs you keeps a read review row\'s three actions whole whatever width was kept for them');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await ev(`localStorage.removeItem('coral-dt-widths:Needs you'); true`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
