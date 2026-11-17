// #19056: a subagent opened from chat closes without loading the lazy task-detail renderer or relying on its registered view.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const modal = `document.getElementById('task-detail-modal')`;
    const cold = () => ev(`import((window.__coralStatic||'/static/')+'lazy_panels.js').then(m=>!m.loadTaskDetail.module)`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        for (const width of [1440,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => {const inner=window.fetch, json=b=>Promise.resolve(Response.json(b));
                window.fetch=(u,o={})=>{const p=new URL(String(u && u.url || u),location.href).pathname;
                    if(p.endsWith('/subagents'))return json([{id:1,subagent_id:'child-close',session_id:'parent-close',description:'Review the login flow',subagent_type:'Explore',status:'completed',finished:true,output_tokens:2300,cache_write_tokens:8100}]);
                    if(p.endsWith('/subagents/child-close'))return json({prompt:'Inspect the login flow',result:'The flow is clear.'});
                    return inner(u,o);};
                window.__m.add('close-parent','S',1,{sleeping:false,session_id:'parent-close',display_name:'Parent'}); })()`);
            await waitFor(`window.__qaState.liveSessions.some(s=>s.session_id==='parent-close')`,'parent agent',6000);
            await ev(`window.selectLiveSession('close-parent','claude','parent-close','local'); true`);
            await ev(`(() => {const p=document.getElementById('agentic-state');if(p.getBoundingClientRect().width<50 || p.classList.contains('collapsed'))(document.getElementById('panel-toggle-btn')||document.getElementById('popout-panel-toggle-btn'))?.click();})()`);
            await waitFor(`!!document.getElementById('agentic-tab-subagents')`,'subagent tab from chat',6000);
            await ev(`document.getElementById('agentic-tab-subagents').click();true`);
            await waitFor(`!!document.querySelector('#agentic-panel-subagents [data-subagent-id="child-close"]')`,'subagent row',6000);
            assert.ok(await cold(),'task-detail has never been loaded');
            for(const registered of [true,false]) {
                if(!registered)await ev(`import((window.__coralStatic||'/static/')+'task_hooks.js').then(m=>m.registerTaskView(null))`);
                for(const method of ['Close','Escape','backdrop']) {
                    await ev(`document.querySelector('#agentic-panel-subagents [data-subagent-id="child-close"]').click();true`);
                    await waitFor(`getComputedStyle(${modal}).display !== 'none'`,method+' opens',5000);
                    if(method==='Close')await ev(`document.querySelector('#task-detail-modal-footer button').click();true`);
                    else if(method==='backdrop')await ev(`${modal}.click();true`);
                    else {await Input.dispatchKeyEvent({type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await Input.dispatchKeyEvent({type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});}
                    await waitFor(`getComputedStyle(${modal}).display === 'none'`,`${width} ${method} closes (Tasks registered=${registered})`,3000);
                    assert.equal(await ev(`!!${modal}._escHandler`),false,method+' releases Escape listener');
                    assert.ok(await cold(),method+' does not fetch task-detail to close');
                }
            }
        }
        console.log('PASS subagent Close, Escape and backdrop work from chat with cold task detail and with no task-view callback');
    } finally {await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
