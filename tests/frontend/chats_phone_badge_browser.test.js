// A chat row on a phone keeps its provider badge on the title's line (#7722, the #7720 audit's finding 6): a short title and the badge are one line, and a long title that wraps to two lines has the
// badge beside its end rather than a line of its own under it. 390 px with touch, isolated dev server, the history list stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const SESSIONS = [
    { session_id: 'bbbbbbbb-0001', title: 'Planning chat', display_name: 'Lead', agent_name: 'Lead', source_type: 'codex', last_timestamp: '2026-10-03T10:00:00Z', duration_sec: 120 },
    { session_id: 'bbbbbbbb-0002', title: 'A rather long chat title that goes on and on about the release and the build and the weekly planning', display_name: 'Lead', agent_name: 'Lead', source_type: 'codex', last_timestamp: '2026-10-02T10:00:00Z', duration_sec: 300 },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.switchNavTab('history'); Promise.all([import((window.__coralStatic||'/static/')+'sidebar.js'), import((window.__coralStatic||'/static/')+'view_switch.js')]).then(([sb, vs]) => { sb.showSidebarPane('history'); vs.showView('chats-empty-view'); document.body.setAttribute('data-nav-tab', 'history'); return true; })`); // a local Coral's Chats are the Inbox's folders (#7776): the hub still draws this list, so the suite shows its pane the way the hub's Chats tab does
        await ev(`import((window.__coralStatic||'/static/')+'history_list.js').then(m => { m.renderHistorySessions(${JSON.stringify(SESSIONS)}, 2, 1, 50); return true; })`);
        await waitFor(`document.querySelectorAll('#history-sessions-list li:not(.session-group-header)').length === 2 && document.querySelector('#history-sessions-list .chat-row-title .chip')`, 'the chat rows with their badges', 10000);
        const rows = await ev(`[...document.querySelectorAll('#history-sessions-list li:not(.session-group-header)')].map(li => { const l = li.querySelector('.session-label').getBoundingClientRect(), b = li.querySelector('.chat-row-title .chip').getBoundingClientRect(); return { label: li.querySelector('.session-label').textContent.slice(0, 20), labelTop: Math.round(l.top), labelBottom: Math.round(l.bottom), labelH: Math.round(l.height), badgeTop: Math.round(b.top), badgeBottom: Math.round(b.bottom), badgeLeft: Math.round(b.left), labelRight: Math.round(l.right) }; })`);
        for (const r of rows) assert.ok(r.badgeTop < r.labelBottom - 4 && r.badgeLeft >= r.labelRight - 2, `${r.label}: the badge is on the title's line, beside it, not under it ${JSON.stringify(r)}`);
        console.log('PASS the provider badge stays on the title line on a phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
