// The select box's 44 px label (#9576) must keep the table's range selection: a click on the label selects its row without opening it, and a shift-click on another row's label selects every row between
// (the checkbox's own shift-click did, #7743). Real mouse events, 1280 px, the Inbox's Tasks folder over the census world (three tasks), isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const T = '#group-table-view';
    const click = async (i, modifiers = 0) => {
        const p = await ev(`(() => { const l = document.querySelectorAll('${T} tr.dt-row .dt-check-hit')[${i}]; const r = l.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y, modifiers });
        await Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers });
        await Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers });
    };
    const selected = () => ev(`[...document.querySelectorAll('${T} tr.dt-row')].map(tr => tr.classList.contains('dt-selected'))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(INBOX_WORLD);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tr.dt-row .dt-check-hit').length === 3`, 'the three tasks, each with a select label', 10000);
        await click(0);
        await waitFor(`document.querySelectorAll('${T} tr.dt-row.dt-selected').length === 1`, 'a click on the label selects its row', 4000);
        assert.deepEqual(await selected(), [true, false, false], 'only the first row');
        assert.equal(await ev(`document.getElementById('inbox-page').getClientRects().length > 0`), false, 'and the row did not open');
        await click(2, 8); // shift
        await waitFor(`document.querySelectorAll('${T} tr.dt-row.dt-selected').length === 3`, 'a shift-click on the label selects the range', 4000);
        assert.deepEqual(await selected(), [true, true, true], 'the range from the first row to the third');
        assert.equal(await ev(`document.getElementById('inbox-page').getClientRects().length > 0`), false, 'and still nothing opened');
        console.log('PASS the select label keeps range selection');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
