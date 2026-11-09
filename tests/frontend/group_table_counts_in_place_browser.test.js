// A count that lands late is written in place (#14877, QA Reviewer 2 on #14844): the review pages' total going from null to 0 and a completeness flag flipping changed the Needs table's draw string, so the table was drawn
// again about 176 ms after the Goals count and a subject or Goal link clicked in that instant was replaced. The head's count and the status line under it are now written into the page where they are; the rows are not drawn again.
// A stand-in group source (a table with a toolbar head, a row with a link, a count and a status) is opened and its words changed: the link node, the row and the toolbar are the same nodes, and the words follow. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`(async () => { const G = await import(${S} + 'sidebar_groups.js'); window.__G = G; window.__spec = { count: 'at least 3', status: 'Checking…' };
                const bar = document.createElement('div'); bar.className = 'list-bar'; bar.innerHTML = '<div class="list-bar-search-row"><input class="gt-search" aria-label="Search"></div>';
                G.registerGroupSource('zz-counts', { keys: () => ['k'], redraw() {}, isEmpty: () => false, showList() {}, empty() {}, toolbar: () => ({ node: bar, signature: 'bar' }),
                    table: () => ({ title: 'Needs you', noun: ['item', 'items'], count: window.__spec.count, status: window.__spec.status, rows: [{ id: 1 }], empty: null, node: () => { const d = document.createElement('div'); d.className = 'zz-rows'; d.innerHTML = '<a class="zz-link" href="#x">Goal 1</a>'; return d; }, signature: 'rows' }) });
                return G.openGroupTable('zz-counts', 'k'); })()`);
            await waitFor(`!!document.querySelector('#group-table-view .zz-link')`, `${at}the stand-in table`, 8000);
            await ev(`window.__link = document.querySelector('#group-table-view .zz-link'); window.__rows = document.querySelector('#group-table-view .zz-rows'); window.__head = document.querySelector('#group-table-view .inbox-folder-head'); true`);
            const before = await ev(`({ count: (document.querySelector('#group-table-view .session-group-count') || {}).textContent, status: (document.querySelector('#group-table-view .group-table-status') || {}).textContent })`);
            check(before.count === 'at least 3' && before.status === 'Checking…', `${at}the stand-in draws its count and status first: ${JSON.stringify(before)}`);
            // the counts land: the words change, the rows do not
            await ev(`window.__spec = { count: '0', status: 'All checked' }; window.__G.refreshGroupTable('zz-counts'); true`);
            const after = await ev(`({ count: (document.querySelector('#group-table-view .session-group-count') || {}).textContent, status: (document.querySelector('#group-table-view .group-table-status') || {}).textContent,
                sameLink: window.__link === document.querySelector('#group-table-view .zz-link') && window.__link.isConnected, sameRows: window.__rows === document.querySelector('#group-table-view .zz-rows'), sameHead: window.__head === document.querySelector('#group-table-view .inbox-folder-head') })`);
            check(after.count === '0' && after.status === 'All checked', `${at}the head's count and the status follow in place: ${JSON.stringify(after)}`);
            check(after.sameLink && after.sameRows, `${at}the row and its link are the very same nodes (not drawn again): ${JSON.stringify(after)}`);
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('group_table_counts_in_place_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
