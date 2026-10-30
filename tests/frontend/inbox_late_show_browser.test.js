// A tab's content that loads after the person has already moved on must not cover where they went (#7704, found by the notification_opens_agents_tab flake): on a fresh page the Inbox tab's module
// arrives late, and its showInbox() opened the Inbox's group table over an agent that was selected in the meantime (the Agents tab highlighted, the agent's view hidden). Here the agent is selected in
// the same tick as the switch to the Inbox tab, on a cold page, three times. Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { framesJs, coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        for (let i = 1; i <= 3; i++) {
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`window.__m.add('gamma', 'G', 6, { sleeping: false }); true`);
            await ev(`window.switchNavTab('hub-inbox'); window.selectLiveSession('gamma', 'claude', 'gamma-id', 'local'); true`);
            await waitFor(`window.__qaState.currentSession && window.__qaState.currentSession.name === 'gamma'`, `run ${i}: the agent to be selected`);
            // the Inbox's module has been fetched (what the tab switch asked for); give what it does with the page a few frames
            await waitFor(`performance.getEntriesByType('resource').some(e => /inbox_sidebar\\.js/.test(e.name) && e.responseEnd > 0)`, `run ${i}: the Inbox's module to arrive`);
            await ev(framesJs(4));
            const r = await ev(`(() => { const v = document.getElementById('live-session-view'), g = document.getElementById('group-table-view'); return { tab: [...document.querySelectorAll('.top-nav-tab.active')].map(b => b.id), view: !!v && v.offsetParent !== null, table: !!g && g.offsetParent !== null }; })()`);
            assert.deepEqual(r.tab, ['nav-tab-agents'], `run ${i}: the Agents tab is the highlighted one ${JSON.stringify(r)}`);
            assert.equal(r.view, true, `run ${i}: the agent selected after the switch is on screen ${JSON.stringify(r)}`);
            assert.equal(r.table, false, `run ${i}: the Inbox's table does not cover it ${JSON.stringify(r)}`);
        }
        console.log('PASS the Inbox tab opening late does not cover a selected agent');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
