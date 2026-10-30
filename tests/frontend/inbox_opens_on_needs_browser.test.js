// The Inbox opens on Needs you when something needs the person (#10205, Mobile tester: the Inbox reopened on the last folder, Tasks, while an agent waited for them, so a newcomer could miss what needed them). A reopen of the Inbox tab lands
// on Needs you when it has items, whatever folder was last on screen; with nothing waiting the remembered folder stays; a link to a folder (selectInboxTab) still opens that folder. 1280 and 390 px, isolated dev server, the harness's stand-in agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const group = () => ev(`(() => { const t = document.getElementById('group-table-view'); return t && t.getClientRects().length > 0 ? t.dataset.group : ''; })()`);
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
            await ev(`localStorage.removeItem('coral.inbox.tab'); true`);
            await ev(`(() => { window.__waiting = []; const entry = window.__m.entry.bind(window.__m); window.__m.entry = a => ({ ...entry(a), waiting_for_input: window.__waiting.includes(a.session_id), waiting_kind: window.__waiting.includes(a.session_id) ? 'permission' : null });
                window.__m.add('QA Alpha', 'A', 4, { sleeping: false, board_project: 'team-a', session_id: 'qa-a-id' }); return true; })()`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 1`, 'the agent in the live list', { timeout: 8000 });
            const refresh = () => ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            const open = async () => { await ev(`window.switchNavTab('hub-inbox'); true`); await settle(900); };
            const leave = async () => { await ev(`window.switchNavTab('agents'); true`); await settle(400); };
            // Tasks was the last folder; nothing waits: the Inbox reopens on Tasks
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`); await settle(700);
            assert.equal(await group(), 'hub-inbox:tasks', `${label}: Tasks is open`);
            await leave(); await open();
            assert.equal(await group(), 'hub-inbox:tasks', `${label}: nothing waits, so the remembered folder (Tasks) is where it reopens`);
            // an agent waits: leaving and coming back lands on Needs you
            await leave(); await ev(`window.__waiting = ['qa-a-id']; true`); await refresh(); await settle(300);
            await open();
            assert.equal(await group(), 'hub-inbox:needs', `${label}: something waits for the person: the Inbox reopens on Needs you, not on Tasks`);
            // nothing waits again: the folder from before Needs you was opened for the person comes back (Needs you was chosen for them, not by them)
            await leave(); await ev(`window.__waiting = []; true`); await refresh(); await settle(300);
            assert.equal(await ev(`localStorage.getItem('coral.inbox.tab')`), 'tasks', `${label}: Needs you opened for the person is not the remembered folder`);
            await open();
            assert.equal(await group(), 'hub-inbox:tasks', `${label}: nothing waits again: the Inbox reopens on Tasks, not on an empty Needs you`);
            // a link to a folder still opens that folder
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`); await settle(500);
            assert.equal(await group(), 'hub-inbox:tasks', `${label}: a chosen folder opens`);
            console.log(`ok ${label}`);
        }
        console.log('PASS the Inbox reopens on Needs you when something waits, and on the remembered folder when nothing does');
    } finally { await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
