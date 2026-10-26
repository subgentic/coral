// The Inbox's tables on a phone (#7722, the #7720 audit's finding 4): the Tasks table fits 390 px without a sideways scroll (each row stacks: the task, then its priority, state and team under it, as the Saved table
// does), and "Back to the list" and the table's title are one row, not two. 390 px with touch, isolated dev server, the Inbox's census world.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(INBOX_WORLD);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 3 && document.getElementById('group-table-view').getClientRects().length > 0`, 'the three tasks', 10000);
        const m = await ev(`(() => { const v = document.getElementById('group-table-view'), sc = v.querySelector('.group-table-scroll'), back = v.querySelector('.group-table-back'), h = v.querySelector('#group-table-title');
            const rect = e => e ? e.getBoundingClientRect() : null; const b = rect(back), t = rect(h);
            return { scroll: sc ? [sc.scrollWidth, sc.clientWidth] : null, page: [document.documentElement.scrollWidth, document.documentElement.clientWidth], backTop: b && Math.round(b.top), titleTop: t && Math.round(t.top), backH: b && Math.round(b.height), titleH: t && Math.round(t.height),
                rows: [...v.querySelectorAll('tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim()) }; })()`);
        assert.ok(m.scroll && m.scroll[0] <= m.scroll[1] + 1, `the Tasks table does not scroll sideways (scrollWidth ${m.scroll && m.scroll[0]} > ${m.scroll && m.scroll[1]}) ${JSON.stringify(m)}`);
        assert.ok(m.page[0] <= m.page[1] + 1, 'and neither does the page ' + JSON.stringify(m));
        assert.ok(Math.abs(m.backTop + m.backH / 2 - (m.titleTop + m.titleH / 2)) <= 8, `"Back to the list" and the title are one row (centres ${m.backTop + m.backH / 2} and ${m.titleTop + m.titleH / 2}) ${JSON.stringify(m)}`);
        for (const [i, word] of [[0, /High/], [0, /Open/], [0, /team-a/], [2, /Low/], [2, /In review/], [2, /team-b/]]) assert.match(m.rows[i], word, `row ${i + 1} still says its ${word} ${JSON.stringify(m.rows)}`);
        console.log('PASS the Inbox Tasks table fits a phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
