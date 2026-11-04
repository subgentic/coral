// The Hub draws Coral's own Needs you table when its boot value says so (#13446, #13450): with `inbox: 'native'` alone Needs you is still the Hub's framed page (an iframe at a constant address); with `needs: 'native'` too the
// folder is Coral's own: no frame, its own search box, its own table. The boot value is the Hub's own page config. The two-computer Hub of helpers/hub_world.js, desktop width.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const open = async () => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard'); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    const S = `(window.__coralStatic || '/static/')`;
    let needsNow = false;
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: 'native', needs: () => needsNow, hubPages: true }); // one world; the boot value is read at each load
        for (const needs of [false, true]) {
            needsNow = needs;
            const at = needs ? "needs: 'native': " : "inbox: 'native' alone: ";
            await open();
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            if (!needs) {
                await waitFor(`!!document.querySelector('#group-table-view iframe')`, at + "Needs you is the Hub's frame", 10000);
                assert.equal(await ev(`document.querySelector('#group-table-view iframe').getAttribute('src')`), '/inbox/hub/needs', at + 'at its constant address');
            } else {
                await waitFor(`document.getElementById('group-table-title') && document.getElementById('group-table-title').textContent === 'Needs you'`, at + "Needs you is Coral's own table", 10000);
                assert.equal(await ev(`!!document.querySelector('#group-table-view iframe')`), false, at + 'no frame');
                assert.equal(await ev(`(() => { const i = document.querySelector('.sidebar-search input'); return !!i && !i.disabled; })()`), true, at + 'its own search box is on');
            }
            console.log(`   ok ${at}`);
        }
        console.log("PASS Needs you is the Hub's frame until the Hub's boot value moves it to Coral's own table");
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
