// A permission row that the person may not answer opens the Agents tab as before (#11837): through Coral Hub a computer the account may only view refuses the card (canOpenCard: blockedReason 'interact'), so Open does not
// put up the dialog with choices that would be refused, it goes to the agent. The stubbed Hub of helpers/hub_world.js (cloud mode, the Laptop is view-only, the Desktop allows interacting). 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    const row = server => ({ name: 'be-' + server, session_id: `0000000${server === 'm1' ? 1 : 2}-0000-4000-8000-00000000000${server === 'm1' ? 1 : 2}`, agent_type: 'claude', server, status: 'idle', display_name: server === 'm1' ? 'Laptop agent' : 'Desktop agent', working_directory: '/repo', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Do you trust the files in this folder?', waiting_since: new Date(Date.now() - 120000).toISOString() });
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`import(${S} + 'server_access.js').then(m => Promise.all([m.serverAccess('m1'), m.serverAccess('m2')])).then(() => true)`); // the access answers are known before a row is opened
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = [${JSON.stringify(row('m1'))}, ${JSON.stringify(row('m2'))}]; m.updateInboxTab(); window.switchNavTab('hub-inbox'); await m.selectInboxTab('needs'); return true; })()`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 2`, 'the two permission rows', 15000); await ev(framesJs(6));
        const can = await ev(`import(${S} + 'inbox_agent_card.js').then(m => [m.canOpenCard(${JSON.stringify(row('m1'))}), m.canOpenCard(${JSON.stringify(row('m2'))})])`);
        assert.deepEqual(can, [false, true], 'the view-only Laptop refuses the card, the Desktop allows it: ' + JSON.stringify(can));
        const open = name => ev(`[...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes(${JSON.stringify(name)})).querySelector('.dt-primary').click(); true`);
        await open('Laptop agent'); await ev(framesJs(8));
        assert.equal(await ev(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`), false, 'a view-only computer\'s permission row puts up no card dialog');
        await waitFor(`document.querySelector('.top-nav-tab.active')?.dataset.arg === 'agents'`, 'it opened the agent instead, as before', 8000);
        console.log('needs_permission_hub_viewer_browser: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
