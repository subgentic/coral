// A column edge follows the pointer (#12409, Beta Tester's v2.0.35 report on the Inbox tables): dragging an edge right moved it right and left moved it left (it had narrowed the column on its left and widened another), the Item edge and every edge
// between data columns work, the table keeps its width and never scrolls sideways, the last column has no handle (its edge is the table's), and "Reset column widths" takes the kept widths back. Real mouse events on the Needs you table at 1280 and
// 1440 px with a waiting agent (the CLI and Folder columns), a question and review files on the isolated server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const S = `(window.__coralStatic || '/static/')`, team = 'edge-' + Date.now().toString(36), T = '#group-table-view';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[1280, 800], [1440, 900]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); sessionStorage.clear(); true`); await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            const post = (path, body) => ev(`fetch(${JSON.stringify(path)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
            await post(`/api/board/${team}/subscribe`, { subscriber_id: 'Operator', job_title: 'Operator' }); await post(`/api/board/${team}/subscribe`, { subscriber_id: 'Writer', job_title: 'Writer' });
            await post(`/api/board/${team}/messages`, { subscriber_id: 'Writer', content: '@Operator may I go ahead with the launch plan?', ask: true });
            await ev(`window.__m.add('proj1', 'A', 2, { sleeping: false, session_id: 'w-sid', display_name: 'Writer', board_project: '${team}' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => ({ ...window.__m.entry(a), waiting_for_input: true, working_directory: '/Users/someone/Projects/a-folder', agent_type: 'claude' }))); true`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 2 && document.querySelectorAll('${T} thead th .dt-resize').length >= 2`, at + 'the table and its handles', 12000); await ev(framesJs(8));
            const snap = () => ev(`(() => { const box = document.querySelector('${T} .dt-box'), t = box.querySelector('table'); return { box: Math.round(box.clientWidth), sw: box.scrollWidth, table: Math.round(t.getBoundingClientRect().width), cols: [...t.querySelectorAll('thead th')].filter(x => x.getClientRects().length).map(x => { const r = x.getBoundingClientRect(), hd = x.querySelector('.dt-resize'); return { key: x.dataset.key, w: Math.round(r.width), right: Math.round(r.right), handle: hd && !hd.hidden ? Math.round(hd.getBoundingClientRect().left + hd.getBoundingClientRect().width / 2) : null, visible: !!hd && !hd.hidden }; }) }; })()`);
            const drag = async (x, y, dx) => { const m = (type, px, b) => Input.dispatchMouseEvent({ type, x: px, y, button: 'left', buttons: b, clickCount: 1 }); await m('mouseMoved', x, 0); await m('mousePressed', x, 1); for (let k = 1; k <= 8; k++) await m('mouseMoved', x + dx * k / 8, 1); await m('mouseReleased', x + dx, 0); await ev(framesJs(6)); };
            const rowY = () => ev(`(() => { const r = document.querySelector('${T} thead th').getBoundingClientRect(); return Math.round(r.top + r.height / 2); })()`);
            const first = await snap();
            const withHandle = first.cols.filter(c => c.handle != null && c.visible);
            assert.ok(withHandle.length >= 2, at + 'the data columns have handles: ' + JSON.stringify(first.cols));
            assert.equal(first.cols[first.cols.length - 1].handle, null, at + 'the last column (Actions) has no handle: ' + JSON.stringify(first.cols.slice(-1)));
            const best = {};
            for (const key of withHandle.map(c => c.key)) for (const dx of (key === first.cols[0].key ? [-60, 60] : [-16, 16])) { // narrower first: the room a drag right needs is what the drag left gave
                if (dx < 0 && await ev(`!document.querySelector('${T} .cols-reset-btn').hidden`)) { await ev(`document.querySelector('${T} .cols-reset-btn').click(); true`); await ev(framesJs(6)); } // each edge starts from the table as it comes // the columns on the right can give only what is above their floors: a small drag is always possible
                const before = await snap(), col = before.cols.find(c => c.key === key), y = await rowY();
                await drag(col.handle, y, dx);
                const after = await snap(), now = after.cols.find(c => c.key === key);
                const moved = now.right - col.right; (best[key] ||= { max: 0 }); best[key].max = Math.max(best[key].max, Math.abs(moved));
                assert.ok(Math.abs(moved - dx) <= 4 || (Math.abs(moved) < Math.abs(dx) && Math.sign(moved) !== -Math.sign(dx)), `${at}the ${key} edge goes where the pointer goes: ${dx} asked, ${moved} moved (it may stop at a column's floor, never go the other way): ` + JSON.stringify({ before: before.cols.map(c => [c.key, c.w]), after: after.cols.map(c => [c.key, c.w]) }));
                assert.ok(after.table <= after.box + 1 && after.sw <= after.box + 1, `${at}the table keeps its width and does not scroll sideways: ` + JSON.stringify({ box: after.box, table: after.table, sw: after.sw }));
                assert.equal(after.cols.length, before.cols.length, at + 'dragging an edge does not add or remove a column');
            }
            for (const c of withHandle) assert.ok(best[c.key].max >= 12, `${at}the ${c.key} edge can be moved (the most it moved was ${best[c.key].max} px)`);
            // Reset: the kept widths go
            assert.ok(await ev(`!!document.querySelector('${T} .cols-reset-btn') && !document.querySelector('${T} .cols-reset-btn').hidden`), at + 'a Reset column widths button is offered once a width is kept');
            await ev(`document.querySelector('${T} .cols-reset-btn').click(); true`); await ev(framesJs(8));
            const reset = await snap();
            assert.deepEqual(reset.cols.map(c => c.w), first.cols.map(c => c.w), at + 'Reset gives every column the width it had before any drag');
            assert.ok(await ev(`document.querySelector('${T} .cols-reset-btn').hidden`) && !(await ev(`localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('coral-dt-widths:Needs')) || 'none')`)), at + 'and the button and the kept widths are gone');
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    console.log('table_edge_drag_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
