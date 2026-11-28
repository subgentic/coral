// #22094: ledger selectors; all original live-update, no-toast, navigation and literal-text safety assertions retained.
// A phone with the Needs you table open gets no "needs your answer" toast for an agent that table lists (walk 74, #17733): the toasts float at the top of the screen and sat over the rows they repeat,
// covering the trust row's red error line. Elsewhere on a phone the toast is still raised. 390 px, isolated dev server, stubbed agents as in needs_row_opens_chat.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`localStorage.removeItem('coral.inbox.tab'); (() => { const entry = window.__m.entry.bind(window.__m); window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: !!window.__wait?.[a.session_id], waiting_kind: 'needs_input', waiting_summary: 'Wants to run: rm -rf build' });
            window.__wait = { 'w1-id': true };
            for (const [n, id] of [['w1', 'w1-id'], ['w2', 'w2-id'], ['w3', 'w3-id']]) window.__m.add(n, 'A', 4, { sleeping: false, board_project: 'team-a', session_id: id }); return true; })()`);
        await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 3`, 'the agents in the live list', 8000);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.getElementById('group-table-view')?.dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view .nl-row').length >= 1`, 'the Needs you table', 8000);
        const rise = id => ev(`(async () => { window.__wait['${id}'] = true; const row = { ...window.__m.entry(window.__m.agents['${id}']) }; window.T.ws.handleCoralMessage({ type: 'coral_diff', changed: [row] }); return true; })()`);
        const toasts = () => ev(`[...document.querySelectorAll('#notices .notification-toast')].filter(e => e.getClientRects().length).map(e => e.textContent)`);
        await ev(`document.querySelectorAll('#notices .notification-toast').forEach(e => e.remove()); true`);
        await rise('w2-id'); await new Promise(r => setTimeout(r, 600)); // sleep-ok: a toast would slide in
        assert.deepEqual(await toasts(), [], 'Needs you is open: the question is a row there, so no toast over the table: ' + JSON.stringify(await toasts()));
        // the same question with another page open is still announced by the toast
        await ev(`window.switchNavTab('agents'); true`);
        await waitFor(`document.getElementById('group-table-view')?.dataset.group !== 'hub-inbox:needs' || !document.getElementById('group-table-view').getClientRects().length`, 'the table closed', 8000);
        await rise('w3-id');
        await waitFor(`!!document.querySelector('#notices .notification-toast')`, 'the toast on another page', 8000);
        console.log('\nPASS no answer toast over the Needs you table on a phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
