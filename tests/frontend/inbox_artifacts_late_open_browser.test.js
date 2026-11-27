// #21839: a folder chosen while Inbox's lazy tab is loading wins over its
// late initial draw, even when Needs you has work. Exercise that callback order
// directly, without a timing window or a real agent, on desktop and phone.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired();
            await install(); await coralReady(ev);
            const result = await ev(`(async () => {
                const S = window.__coralStatic || '/static/';
                const { state } = await import(S + 'state.js');
                const m = await import(S + 'inbox_sidebar.js');
                const { needsCount } = await import(S + 'inbox_tab.js');
                state.liveSessions = [{ session_id: 'late-folder-agent', name: 'late-folder-agent', agent_type: 'claude', sleeping: true,
                    asked_before_restart: { text: 'Please check the draft', kind: 'question', at: new Date().toISOString() } }];
                document.body.setAttribute('data-nav-tab', 'hub-inbox');
                // The folder click lands first; the tab's original load callback arrives last.
                await m.openInboxGroup('artifacts');
                const before = document.getElementById('group-table-view').dataset.group;
                const waiting = needsCount();
                await m.showInbox();
                const after = document.getElementById('group-table-view').dataset.group, path = location.pathname;
                // Leaving the tab still resets the reopen rule for a later visit.
                window.switchNavTab('agents');
                await Promise.resolve();
                document.body.setAttribute('data-nav-tab', 'hub-inbox');
                await m.showInbox();
                return { before, waiting, after, path, reopened: document.getElementById('group-table-view').dataset.group };
            })()`);
            assert.ok(result.waiting > 0, 'Needs you has work that would trigger the default');
            assert.equal(result.before, 'hub-inbox:artifacts');
            assert.equal(result.after, 'hub-inbox:artifacts', `${width}: late initial draw preserves the chosen folder`);
            assert.equal(result.path, '/inbox/artifacts', `${width}: the address preserves the chosen folder`);
            assert.equal(result.reopened, 'hub-inbox:needs', `${width}: a later tab visit still applies the normal Needs you default`);
        }
        console.log('PASS desktop and phone preserve Artifacts through the late Inbox draw');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
