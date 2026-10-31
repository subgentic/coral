// The Actions column is the last one in Needs you, at the right edge of the row, its buttons right-aligned (#11552, the operator's request: "as people expect"); Blocks, Waiting and the others stay to its left. 1280 px: the table's
// last visible column is Actions and its last button ends at the cell's right edge; 390 px: a phone row's buttons end at the row's right edge. Review artifacts through the real board API (the team), the artifact list stubbed as the
// server answers, like inbox_needs_actions_width_browser. Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'needs-last-' + Date.now().toString(36);
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const row = name => `[...document.querySelectorAll('#group-table-view tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(name)}))`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const load = async (w, h, mobile) => {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer',job_title:'Writer'})}).then(r=>r.status)`);
            await ev(`(() => {
                localStorage.removeItem('coral-inbox-needs-filters'); localStorage.removeItem('coral-dt-widths:Needs you');
                const mk = (n, tags) => ({ id: n.toString(16).padStart(64, '0'), name: 'Review file 0' + n + '.txt', media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - (10 - n) * 60000).toISOString(), tags, available: true, uri: 'coral://artifacts/' + n.toString(16).padStart(64, '0'), produced_by: 'Review Writer' });
                window.__reviewItems = [mk(1, ['for review']), mk(2, ['for review', 'read']), mk(3, ['for review'])];
                const original = window.fetch, json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (u.pathname === '/api/board/${team}/artifacts') { const items = window.__reviewItems.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))); return json({ project: '${team}', artifacts: items, has_more: false }); }
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
            await waitFor(`!!(${row('Review file 02.txt')})`, 'the review rows in Needs you', 15000);
        };
        const labels = (name) => ev(`[...(${row(name)}).querySelectorAll('.inbox-review-actions button:not(.dt-star):not(.menu-item)')].map(b => (b.getAttribute('aria-label') || b.textContent).trim())`);

        // 1440: Actions is the last visible column, to the right of Waiting; its buttons end at the cell's right edge; the four words, Mark unread in More
        await load(1440, 900, false);
        await waitFor(`document.querySelectorAll('#group-table-view thead th').length > 2`, 'the table header', 8000);
        const wide = await ev(`(() => { const ths = [...document.querySelectorAll('#group-table-view thead th')].filter(t => t.getBoundingClientRect().width > 0), keys = ths.map(t => t.dataset.key);
            const td = ${row('Review file 02.txt')}.querySelector('td[data-key="review"]'), c = td.getBoundingClientRect(), bs = [...td.querySelectorAll('button')].map(b => b.getBoundingClientRect());
            return { keys, gap: Math.round(c.right - Math.max(...bs.map(b => b.right))) }; })()`);
        check(wide.keys[wide.keys.length - 1] === 'review', '1440: the last visible column is Actions: ' + JSON.stringify(wide.keys));
        check(wide.keys.indexOf('waiting') !== -1 && wide.keys.indexOf('waiting') < wide.keys.indexOf('review'), '1440: Waiting is to the left of Actions: ' + JSON.stringify(wide.keys));
        check(wide.gap >= 0 && wide.gap <= 24, '1440: the last button ends at the cell\'s right edge (gap ' + wide.gap + ' px)');
        check(JSON.stringify(await labels('Review file 01.txt')) === JSON.stringify(['Approve: Review file 01.txt', 'Request changes: Review file 01.txt', 'Deny: Review file 01.txt', 'Ignore: Review file 01.txt']), '1440: an unread row has Approve, Changes, Deny, Ignore, in that order, and no Open or refresh icon: ' + JSON.stringify(await labels('Review file 01.txt')));
        check(JSON.stringify(await labels('Review file 02.txt')) === JSON.stringify(['Approve: Review file 02.txt', 'Request changes: Review file 02.txt', 'Deny: Review file 02.txt', 'Ignore: Review file 02.txt', 'More actions for Review file 02.txt']), '1440: a read row has the same four and a More (Mark unread is in it): ' + JSON.stringify(await labels('Review file 02.txt')));
        await shot('needs-actions-last-1440');

        // 1280: the table has room for the item, the task link and the goal, not for four words: Approve, Changes and More (Deny, Ignore, Mark unread), like a phone
        await load(1280, 900, false);
        check(JSON.stringify(await labels('Review file 01.txt')) === JSON.stringify(['Approve: Review file 01.txt', 'Request changes: Review file 01.txt', 'More actions for Review file 01.txt']), '1280: an unread row has Approve, Changes and More: ' + JSON.stringify(await labels('Review file 01.txt')));
        { const fit = await ev(`(() => { const td = ${row('Review file 02.txt')}.querySelector('td[data-key="review"]'), c = td.getBoundingClientRect(), bs = [...td.querySelectorAll('.inbox-review-actions > button, .inbox-row-more-toggle')].map(b => b.getBoundingClientRect()); return { left: Math.round(Math.min(...bs.map(b => b.left)) - c.left), right: Math.round(c.right - Math.max(...bs.map(b => b.right))) }; })()`);
          check(fit.left >= 0 && fit.right >= 0, '1280: the buttons are inside the Actions cell: ' + JSON.stringify(fit)); }
        await shot('needs-actions-last-1280');

        // 390: the phone's row: Approve, Changes and More (Deny, Ignore); its buttons end at the row's right edge
        await load(390, 844, true);
        const phone = await ev(`(() => { const r = ${row('Review file 02.txt')}, box = r.getBoundingClientRect(), bs = [...r.querySelectorAll('.inbox-review-actions button')].map(b => b.getBoundingClientRect()).filter(b => b.width > 0);
            return { n: bs.length, gap: Math.round(box.right - Math.max(...bs.map(b => b.right))), left: Math.round(Math.min(...bs.map(b => b.left)) - box.left) }; })()`);
        check(phone.n >= 3 && phone.gap >= 0 && phone.gap <= 20 && phone.left >= 0, '390: the row\'s buttons end at the row\'s right edge and none is cut off on the left: ' + JSON.stringify(phone));
        check(JSON.stringify(await labels('Review file 01.txt')) === JSON.stringify(['Approve: Review file 01.txt', 'Request changes: Review file 01.txt', 'More actions for Review file 01.txt']), '390: an unread phone row has Approve, Changes and More: ' + JSON.stringify(await labels('Review file 01.txt')));
        await ev(`${row('Review file 02.txt')}.querySelector('.inbox-row-more-toggle').click(); true`);
        await waitFor(`!!document.querySelector('.inbox-row-more-toggle[aria-expanded="true"]')`, '390: the More menu opens', 4000).catch(() => {});
        const items = await ev(`[...document.querySelectorAll('.dt-mail-menu:not([hidden]) .menu-item')].map(b => b.textContent.trim())`);
        check(JSON.stringify(items) === JSON.stringify(['Deny', 'Ignore', 'Mark unread']), '390: the More menu of a read row is Deny, Ignore, Mark unread: ' + JSON.stringify(items));
        await shot('needs-actions-last-390');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await ev(`localStorage.removeItem('coral-dt-widths:Needs you'); true`).catch(() => {}); await client.close(); }
    if (found.length) { console.error(found.join('\n')); process.exit(1); }
    console.log('needs_actions_last_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
