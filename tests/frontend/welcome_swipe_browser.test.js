// #18764: the Getting started items are ordinary Needs rows; one Dismiss removes one and tells no agent (review swipes: needs_phone_rows).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { installGuard, reached } = require('./helpers/silent_dismiss');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width:390,height:844,deviceScaleFactor:1,mobile:true });
        await Emulation.setTouchEmulationEnabled({ enabled:true });
        await Page.navigate({ url:process.env.CORAL_TEST_URL+'/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.__puts=[]; const orig=window.fetch.bind(window);window.fetch=(u,o={})=>{
            if(String(u).includes('/api/settings') && o.method==='PUT'){window.__puts.push(JSON.parse(o.body));return Promise.resolve(new Response('{"ok":true}',{status:200,headers:{'Content-Type':'application/json'}}));}
            return orig(u,o);
        };T.state.settings={...T.state.settings,inbox_welcome:'on',inbox_welcome_done:''};T.state.liveSessions=[];T.state.servers=[];true`);
        await installGuard(ev);
        await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>{m.updateInboxTab();return m.selectInboxTab('needs');}).then(()=>true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length===5`,'five Getting started rows',8000);
        assert.equal(await ev(`!document.querySelector('.inbox-getting-started') && !document.querySelector('button[aria-label="Dismiss Getting started"]')`),true,'no separate block and no Dismiss all');
        assert.equal(await ev(`document.querySelectorAll('#group-table-view tbody tr[data-welcome-id]').length`),4,'each row with a Dismiss declares its id, so a swipe dismisses it like its Dismiss (the welcome row has none)');
        // Dismiss on one row: that item is remembered done, the other four stay, and the count follows. Nothing is sent to an agent.
        await ev(`document.querySelector('#group-table-view tbody tr[data-welcome-id="asks"] .inbox-row-more-toggle, #group-table-view tbody tr[data-welcome-id="asks"] button[aria-label^="More"]')?.click();true`);
        await ev(`(document.querySelector('#group-table-view tbody tr[data-welcome-id="asks"] [aria-label^="Dismiss"]') || [...document.querySelectorAll('.menu-item')].find(b=>b.textContent==='Dismiss')).click();true`);
        await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length===4`,'one row dismissed',8000);
        assert.equal(await ev(`window.__puts.some(x=>/asks/.test(x.inbox_welcome_done||''))`),true,'the dismissal is remembered in the settings');
        assert.deepEqual(await reached(ev),[],'dismissal sends nothing to an agent');
        console.log('PASS Getting started rows dismiss one at a time');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
