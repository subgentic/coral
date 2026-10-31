// Approving an item in Needs you keeps the person's place (#11558, the operator, clearing their inbox): the list does not jump to the top, the scroll stays where it was and the focus moves to the next row's first control (or
// the previous row's, at the end of the list). A long list of 40 review rows, the team's artifact list and the approve write stubbed in the page. 1280 (the table) and 390 (the phone's rows).
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'place-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const S = `(window.__coralStatic || '/static/')`;
    const N = 40;
    const name = i => 'plan-' + String(i).padStart(2, '0') + '.md';
    // the element that scrolls the rows: the nearest ancestor of the table body that overflows, else the page
    const SCROLLER = `(() => { for (let e = document.querySelector('${T} tbody'); e; e = e.parentElement) { const o = getComputedStyle(e).overflowY; if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 1) return e; } return document.scrollingElement; })()`;
    const state = () => ev(`(() => { const s = ${SCROLLER}, rows = [...document.querySelectorAll('${T} tbody tr')], a = document.activeElement, tr = a && a.closest ? a.closest('tr') : null;
        return { top: Math.round(s.scrollTop), names: rows.map(r => (r.textContent.match(/plan-\\d+\\.md/) || [''])[0]), focusRow: tr ? (tr.textContent.match(/plan-\\d+\\.md/) || [''])[0] : '', focusTag: a ? a.tagName : '', inView: (n) => 0 }; })()`);
    const approve = n => ev(`(() => { const b = document.querySelector('${T} button[aria-label="Approve: ${name(n)}"]'); b.scrollIntoView({ block: 'center' }); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 700, false], [390, 700, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = i => ({ id: hex(i), name: 'plan-' + String(i).padStart(2, '0') + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (${N} - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), produced_by: 'Plan Writer', session_id: 's' + i });
                window.__items = Array.from({ length: ${N} }, (_, k) => item(k + 1));
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), m = u.pathname.match(/^\\/api\\/board\\/${team}\\/artifacts(?:\\/([0-9a-f]{64})\\/(review|tags))?$/);
                    if (!m) return original(url, opts);
                    if (!m[1]) return json({ project: '${team}', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    const it = window.__items.find(a => a.id === m[1]);
                    if (m[2] === 'review') { it.tags = it.tags.filter(t => t !== 'for review').concat('approved'); return json({ id: it.id, state: 'approved', changed: true, tags: it.tags, delivered: true, to: 'Plan Writer', review: { state: 'approved', at: new Date().toISOString() } }); }
                    return json({ id: it.id, tags: it.tags }); };
                return true; })()`);
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' })); window.switchNavTab('hub-inbox'); true`); // oldest first: plan-01 is the first row, plan-40 the last
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === ${N}`, at + 'forty review rows', 15000);
            await ev(framesJs(3));

            // approve a row in the middle of the list
            await approve(20); await ev(framesJs(3));
            const before = await state();
            await ev(`document.querySelector('${T} button[aria-label="Approve: ${name(20)}"]').click(); true`);
            await waitFor(`!document.querySelector('${T} button[aria-label="Approve: ${name(20)}"]')`, at + 'the approved row leaves the list', 8000).catch(() => {});
            await ev(framesJs(6));
            const after = await state();
            check(!after.names.includes(name(20)) && after.names.length === N - 1, at + 'the row is gone: ' + after.names.length);
            check(before.top > 200 && Math.abs(after.top - before.top) <= 80, at + 'the list stays where it was (scroll ' + before.top + ' to ' + after.top + ')');
            check(after.focusRow === name(21), at + 'the focus moves to the next row (' + name(21) + '): ' + JSON.stringify({ row: after.focusRow, tag: after.focusTag }));

            // the last row: the focus goes to the one before it
            await approve(N); await ev(framesJs(3));
            await ev(`document.querySelector('${T} button[aria-label="Approve: ${name(N)}"]').click(); true`);
            await waitFor(`!document.querySelector('${T} button[aria-label="Approve: ${name(N)}"]')`, at + 'the last row leaves the list', 8000).catch(() => {});
            await ev(framesJs(6));
            const last = await state();
            check(last.focusRow === name(N - 1), at + 'at the end of the list the focus goes to the previous row (' + name(N - 1) + '): ' + JSON.stringify({ row: last.focusRow, tag: last.focusTag }));
            check(last.top > 200, at + 'and the list is not at the top (scroll ' + last.top + ')');
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('inbox_keep_place_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
