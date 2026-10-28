// A Needs you row opens the agent on its chat, where the card that asks is, whatever view was saved last (#10141, Desktop tester #10138: "opening the row lands on the terminal view, so I had to switch views first").
// The saved choice (Terminal) is not changed: it is for this opening only. 1280 px, isolated dev server, the waiting agent seeded as inbox_local_browser does.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.setItem('coral-live-view-mode', 'terminal'); true`); // Terminal is the last view chosen
        await ev(`(() => { const entry = window.__m.entry.bind(window.__m); window.__m.entry = a => ({ ...entry(a), board_job_title: 'QA Engineer', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: rm -rf build' });
            window.__m.add('d2', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'd2-id' }); return true; })()`);
        await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 1`, 'the agent in the live list', 8000);
        await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
        await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '1'`, 'the waiting badge', 8000);
        await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:needs' && document.querySelectorAll('#group-table-view tbody .dt-primary').length === 1`, 'the Needs you row', 8000);
        await ev(`document.querySelector('#group-table-view tbody .dt-primary').click(); true`);
        await waitFor(`document.querySelector('.top-nav-tab.active')?.dataset.arg === 'agents' && document.getElementById('live-view-btn-chat')?.getAttribute('aria-pressed') === 'true'`, 'the agent opened on its chat', 8000);
        assert.equal(await ev(`localStorage.getItem('coral-live-view-mode')`), 'terminal', 'the saved view is still Terminal: this opening only');
        // the toast for an agent that is not on screen says it needs an answer (#10141)
        await ev(`import((window.__coralStatic || '/static/') + 'notifications.js').then(m => { m.showNotificationToast('d2', 'Wants to run: rm -rf build', () => {}); return true; })`);
        assert.match(await ev(`document.querySelector('.notification-toast-title').textContent.trim()`), /^⏳ d2 needs your answer$/, 'the toast words');
        console.log('\nPASS a Needs you row opens the chat, not the saved terminal');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
