// A goal opened off Needs you remembers the list's place and the row's focus so Back can restore them (#11950, #11964); that note is spent once Back has restored it (#12319, the review's INFO on #11964): a LATER fresh open of Needs you
// (a notification link, or the tab opened again) must not jump to the old scroll offset or give an old row the focus for a second. Real board and goals on the isolated dev server (as needs_goal_back_browser), 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { holdScroll, frames } = require('./helpers/scroll_hold');
const B = 'needs-opener-spent-' + Date.now().toString(36);

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const root = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const T = '#group-table-view';
    const where = () => ev(`({ path: location.pathname, group: document.querySelector('${T}')?.dataset.group || '', onGoal: !!document.querySelector('.goals-open'), needs: /looks done/.test(document.querySelector('${T}')?.textContent || ''), scroll: document.querySelector('${T}')?.scrollTop || 0 })`);
    const openNeeds = async () => {
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, 'a Goal looks done row', 20000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
        await root('PUT', '/api/settings', { goal_done_hidden: '[]' });
        const TITLES = ['Ship the pilot', 'Ship the second', ...Array.from({ length: 7 }, (_, i) => 'Ship extra ' + (i + 1))];
        for (const title of TITLES) {
            const g = await api('POST', '/goals', { subscriber_id: 'Operator', title, done_when: 'it is shipped' }); assert.equal(g.status, 201); const gid = g.json.id || g.json.goal.id;
            const t = await api('POST', '/tasks', { subscriber_id: 'Operator', title: 'Task', goal_id: gid, assigned_to: 'Boss', created_by: 'Operator', priority: 'medium' }); const tid = t.json.id || t.json.task.id;
            assert.ok((await api('POST', '/tasks/claim', { subscriber_id: 'Boss', task_id: tid })).status < 300);
            assert.ok((await api('POST', `/tasks/${tid}/complete`, { subscriber_id: 'Boss', message: 'done', outcome: 'success' })).status < 300);
        }
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 420, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await openNeeds();
            const SCROLLER = `(() => { const tr = document.querySelector('${T} tbody tr'); for (let e = tr; e; e = e.parentElement) { const o = getComputedStyle(e).overflowY; if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 2) return e; } return document.scrollingElement; })()`;
            const rowsOf = `[...document.querySelectorAll('${T} tbody tr')].filter(tr => /looks done/.test(tr.textContent))`;
            await holdScroll(ev, SCROLLER, `${rowsOf}.slice(-2)[0]`); // the list is scrolled down and holds it (not a fixed sleep, which a redraw in the window beat)
            const pos = await ev(`(() => { const el = ${rowsOf}.slice(-2)[0].querySelector('.inbox-review-name'), r = el.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 20), y: r.top + r.height / 2, top: ${SCROLLER}.scrollTop, name: el.textContent }; })()`);
            assert.ok(pos.top > 100, at + 'the list is scrolled down before the goal is opened: ' + JSON.stringify(pos));
            for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await client.Input.dispatchMouseEvent({ type, x: pos.x, y: pos.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
            await waitFor(`!!document.querySelector('.goals-open')`, at + 'the goal opened by a real click', 10000);
            await ev(`history.back(); true`);
            await waitFor(`!document.querySelector('.goals-open') && /looks done/.test(document.querySelector('${T}')?.textContent || '')`, at + 'back on the list', 10000);
            await frames(ev, 90); // the restore holds the list's place for 60 frames, then lets go
            // the opener is spent: a later fresh open of Needs you (another folder, then Needs you again: what a notification link does) starts at the top, with no row holding the focus
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
            await frames(ev, 20); // the folder draws after the route
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`/looks done/.test(document.querySelector('${T}')?.textContent || '')`, at + 'Needs you opened afresh', 15000);
            const seen = [];
            for (let i = 0; i < 6; i++) { await frames(ev, 12); seen.push(await ev(`(() => { const a = document.activeElement, tr = a && a.closest && a.closest('tr[data-key]'); return { top: Math.round(${SCROLLER}.scrollTop), focusRow: tr ? (tr.querySelector('.inbox-review-name')?.textContent || tr.dataset.key) : '' }; })()`)); }
            assert.ok(seen.every(s => s.top <= 40), at + 'a fresh open of Needs you starts at the top, it is not thrown back to the old offset ' + pos.top + ': ' + JSON.stringify(seen));
            assert.ok(seen.every(s => s.focusRow !== pos.name), at + 'and the old row does not take the focus: ' + JSON.stringify(seen));
        }
        console.log('PASS the Needs you opener is spent once Back has restored it');
    } finally { await guard.restore().catch(() => {}); await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
