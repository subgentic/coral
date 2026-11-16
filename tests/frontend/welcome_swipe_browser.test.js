// #16862: Welcome is now a separate Getting started list, outside swipeable Needs rows.
// Its dismiss button persists the setting and tells no agent; review swipes remain covered by needs_phone_rows.
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
        await waitFor(`document.querySelectorAll('.inbox-getting-started li').length===5`,'five Getting started items',8000);
        assert.equal(await ev(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length`),0,'onboarding is outside swipeable Needs rows');
        assert.equal(await ev(`document.querySelectorAll('.inbox-getting-started [data-welcome-id], .inbox-getting-started input[type=checkbox]').length`),0,'onboarding does not declare swipe or bulk-selection targets');
        await ev(`document.querySelector('button[aria-label="Dismiss Getting started"]').click();true`);
        await waitFor(`!document.querySelector('.inbox-getting-started')`,'block dismissed',8000);
        assert.equal(await ev(`window.__puts.some(x=>x.inbox_welcome==='off')`),true,'dismissal persists the existing setting');
        assert.deepEqual(await reached(ev),[],'dismissal sends nothing to an agent');
        console.log('PASS Getting started stays outside Needs swipe and bulk selection');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
