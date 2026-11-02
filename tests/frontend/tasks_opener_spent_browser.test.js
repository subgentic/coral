// The Tasks folder's opener is spent once Back has used it (#12319, the review's MUST on its first round): opening a task from Inbox > Tasks stores the list's scroll offset and the row's key so Back can put them back; that
// note must not outlive the Back, or a LATER fresh open of Tasks (another folder, then Tasks again) is thrown back to the old offset with the old row focused. It is the other consumer of the opener (openInboxGroup), not the one
// Needs you uses. Twelve tasks assigned to the Operator on a real board; a short window so the list scrolls; a real mouse click on a row far down; Back; the restore lets go; another folder, then Tasks again.
// 1280 and 390 px, isolated dev server. (Board history stores its opener the same way, but its key is the chat's session id, which no row of the list carries as its data-key, so a stale one finds no row and restores nothing:
// the symptom cannot show there, and no test can pin its delete.)
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { guardSettings } = require('./helpers/settings_guard');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { holdScroll, frames } = require('./helpers/scroll_hold');
const B = 'tasks-opener-spent-' + Date.now().toString(36);

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    const api = (method, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const openFolder = name => ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(name)})).then(() => true)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B })).status < 300);
        for (let i = 1; i <= 12; i++) assert.ok((await api('POST', '/tasks', { title: 'Task number ' + i, created_by: 'Operator', assigned_to: 'Operator', priority: 'medium' })).status < 300, 'task ' + i);
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 420, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await openFolder('tasks');
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 12`, at + 'the twelve tasks are listed', 20000);
            const SCROLLER = `(() => { const tr = document.querySelector('${T} tbody tr'); for (let e = tr; e; e = e.parentElement) { const o = getComputedStyle(e).overflowY; if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 2) return e; } return document.scrollingElement; })()`;
            const rows = `[...document.querySelectorAll('${T} tbody tr')]`;
            const top = await holdScroll(ev, SCROLLER, `${rows}.slice(-3)[0]`);
            const pos = await ev(`(() => { const tr = ${rows}.slice(-3)[0], el = tr.querySelector('.dt-primary') || tr, r = el.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 20), y: r.top + r.height / 2, name: (tr.textContent.match(/Task number \\d+/) || [''])[0] }; })()`);
            assert.ok(top > 100 && pos.name, at + 'the list is scrolled down and holds it: ' + JSON.stringify({ top, pos }));
            for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await client.Input.dispatchMouseEvent({ type, x: pos.x, y: pos.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
            await waitFor(`/^\\/inbox\\/tasks\\/.+/.test(location.pathname)`, at + 'the task opened by a real click (its own route)', 10000);
            await ev(`history.back(); true`);
            await waitFor(`/^\\/inbox\\/tasks\\/?$/.test(location.pathname) && document.querySelectorAll('${T} tbody tr').length >= 12`, at + 'back on the Tasks list', 10000);
            await frames(ev, 90); // the restore holds the list's place for 60 frames, then lets go
            // the opener is spent: another folder and then Tasks again (a fresh open) starts at the top, no old row holds the focus
            await openFolder('goals'); await frames(ev, 20);
            await openFolder('tasks');
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 12`, at + 'Tasks opened afresh', 15000);
            const seen = [];
            for (let i = 0; i < 6; i++) { await frames(ev, 12); seen.push(await ev(`(() => { const a = document.activeElement, tr = a && a.closest && a.closest('tr[data-key]'); return { top: Math.round(${SCROLLER}.scrollTop), focusRow: tr ? ((tr.textContent.match(/Task number \\d+/) || [''])[0] || tr.dataset.key) : '' }; })()`)); }
            assert.ok(seen.every(s => s.top <= 40), at + 'a fresh open of Tasks starts at the top, it is not thrown back to the old offset ' + top + ': ' + JSON.stringify(seen));
            assert.ok(seen.every(s => s.focusRow !== pos.name), at + 'and the old row (' + pos.name + ') does not take the focus: ' + JSON.stringify(seen));
        }
        console.log('PASS the Tasks folder opener is spent once Back has restored it');
    } finally { await guard.restore().catch(() => {}); await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
