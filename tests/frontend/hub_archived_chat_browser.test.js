// #12637: native Hub Inbox preserves Archived on desktop, touch phone, and reload.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    try {
        await setupHubWorld({ client, Page, Emulation, width:1280, height:844, mobile:false, inbox:'native', hubPages:true });
        const open = async path => {
            await Page.navigate({ url: BASE + path }); await Page.loadEventFired();
            await waitFor(`!!window.__coralReady && typeof window.selectHistorySession === 'function'`, 'dashboard');
            await coralReady(ev, 'startup', 'liveList', 'settings');
        };
        for (const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({ width, height:844, deviceScaleFactor:1, mobile:width===390 });
            await Emulation.setTouchEmulationEnabled({ enabled:width===390 });
            await open('/inbox/chats/archived');
            await waitFor(`!!document.querySelector('#group-table-view .dt-primary')`, 'archived chat row');
            await ev(`document.querySelector('#group-table-view .dt-primary').click(); true`);
            await waitFor(`document.getElementById('history-messages').textContent.includes('needle')`, 'remote transcript');
            assert.match(await ev(`location.pathname`), /^\/inbox\/chats\/archived\/@m[12]\/same-chat$/, 'folder stays in chat URL');
            const path = await ev('location.pathname');
            for (const reload of [false,true]) {
                if (reload) { await open(path); await waitFor(`document.getElementById('history-messages').textContent.includes('needle')`, 'reloaded transcript'); }
                const selector=width===390?'.mobile-history-back':'#history-back';
                assert.equal(await ev(`document.querySelector('${selector}').textContent.trim()`), '← Archived', 'back names Archived');
                await ev(`document.querySelector('${selector}').click();true`);
                await waitFor(`location.pathname === '/inbox/chats/archived' && document.getElementById('group-table-view').checkVisibility()`, 'back to Archived');
                if (!reload) { await open(path); await waitFor(`document.getElementById('history-messages').textContent.includes('needle')`, 'chat again'); }
            }
        }
        console.log('PASS archived Hub chat back link and reload at 1280 and touch 390');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
