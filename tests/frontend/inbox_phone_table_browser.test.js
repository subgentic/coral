// The Inbox's tables on a phone (#7722, the #7720 audit's finding 4): the Tasks table fits 390 px without a sideways scroll (each row is the one task row's two lines: the task, then its state and a High priority, #7737; Saved's table
// does), and the folders' drawer button (#7785, #9545) is on top of the table, 44 px, in place of a way back. 390 px with touch, isolated dev server, the Inbox's census world.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { axName } = require('./helpers/ax_tree');
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
        await waitFor(`document.querySelectorAll('#group-table-view .dt-table tbody tr').length === 3 && document.getElementById('group-table-view').getClientRects().length > 0`, 'the three tasks', 10000);
        await waitFor(`!!document.querySelector('#group-table-view .dt-box.dt-folded')`, 'the table has folded to its phone rows', 5000); // the fold is the table's own box: it settles after the first paint (#7868)
        const m = await ev(`(() => { const v = document.getElementById('group-table-view'), sel = v.querySelector('.view-list-trigger'), sc = v.querySelector('.dt-box'), back = v.querySelector('.group-table-back'), h = v.querySelector('#group-table-title');
            const rect = e => e ? e.getBoundingClientRect() : null; const b = rect(back), t = rect(h);
            return { select: sel && { h: Math.round(sel.getBoundingClientRect().height), top: Math.round(sel.getBoundingClientRect().top), current: sel.querySelector('.view-list-trigger-name').textContent }, back: !!back, scroll: sc ? [sc.scrollWidth, sc.clientWidth] : null, page: [document.documentElement.scrollWidth, document.documentElement.clientWidth], backTop: b && Math.round(b.top), titleTop: t && Math.round(t.top), backH: b && Math.round(b.height), titleH: t && Math.round(t.height),
                rows: [...v.querySelectorAll('.dt-table tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim()) }; })()`);
        assert.ok(m.scroll && m.scroll[0] <= m.scroll[1] + 1, `the Tasks table does not scroll sideways (scrollWidth ${m.scroll && m.scroll[0]} > ${m.scroll && m.scroll[1]}) ${JSON.stringify(m)}`);
        assert.ok(m.page[0] <= m.page[1] + 1, 'and neither does the page ' + JSON.stringify(m));
        assert.ok(m.select && m.select.h >= 44 && m.select.top < m.titleTop && m.select.current === 'Tasks' && !m.back, `the folders' drawer button is on top of the table, 44 px, naming the current folder, with no way back ${JSON.stringify(m)}`);
        // the one task row's two-line form (#7737): the id and title, then the state, and the priority only when it is High; the team is the table's column and is not in the phone's line
        for (const [i, word] of [[0, /Queued/], [1, /In progress/], [2, /In review/]]) assert.match(m.rows[i], word, `row ${i + 1} still says its ${word} ${JSON.stringify(m.rows)}`);
        assert.ok(m.rows.every(r => !/Nobody yet/.test(r)), 'the Inbox says nothing of who: every task is the operator\'s ' + JSON.stringify(m.rows));
        await ev(`document.querySelectorAll('#group-table-view .dt-table tbody tr .dt-primary').forEach((b, i) => b.setAttribute('data-axp', String(i))); true`);
        for (const [i, state] of [[0, 'Queued'], [1, 'In progress'], [2, 'In review']]) { const ax = await axName(client, `[data-axp="${i}"]`); assert.match(ax && ax.name, new RegExp(`^#${i + 1} .+, ${state}, .+$`), `row ${i + 1}'s button is "<task>, <state>, <time>" as Chrome computes it (the state is on the row as an icon and a word: #9747): ${ax && ax.name}`); }
        console.log('PASS the Inbox Tasks table fits a phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
