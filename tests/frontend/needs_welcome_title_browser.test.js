// Phone Needs you, the welcome rows (#11933, the Mobile Beta Tester's report on v2.0.29): a welcome row showed only its description, no title: the title's cell was 0 px high, because the phone rule that pulls a name's 44 px target
// back by 12 px above and below (#11858) left a cell with nothing but the name no height at all, and the cell clips. Every welcome row shows its title above its description, in the row, and the row is tall enough for both. 390 px,
// a fresh Inbox with no agent.
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], S = `(window.__coralStatic || '/static/')`;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`T.state.settings = { ...T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; T.state.liveSessions = []; T.state.servers = []; true`);
        await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length === 5`, 'five welcome rows', 8000); await ev(framesJs(8));
        const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(tr => { const n = tr.querySelector('.inbox-welcome-name'), cell = n.closest('td'), r = n.getBoundingClientRect(), c = cell.getBoundingClientRect(), t = tr.getBoundingClientRect(), d = tr.querySelector('td[data-key=asks]'); return { title: n.firstChild.textContent, cellH: Math.round(c.height), nameH: Math.round(r.height), inRow: r.top >= t.top - 1 && r.bottom <= t.bottom + 1, aboveText: !d || r.bottom <= d.getBoundingClientRect().top + 1, rowH: Math.round(t.height) }; })`);
        check(rows.length === 5, 'five welcome rows: ' + JSON.stringify(rows));
        for (const x of rows) check(x.cellH >= x.nameH && x.nameH > 10 && x.inRow && x.aboveText, 'the welcome row "' + x.title + '" shows its title in the row, above its description (its cell is as tall as the title): ' + JSON.stringify(x));
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_welcome_title_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
