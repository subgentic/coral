// #14032: the question dialog uses its captured computer for Dismiss, Undo and offered replies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await setupHubWorld({client,Page,Emulation,width:1280,height:1000,mobile:false,inbox:'native',needs:true,hubPages:true});
        await Page.addScriptToEvaluateOnNewDocument({source:`(() => {
            const old=window.fetch, json=(v,status=200)=>Promise.resolve(Response.json(v,{status}));
            window.__owner=true; window.__dismissed=false; window.__writes=[];
            window.__ask={server:'m2',board:'same-team',kind:'ask',id:17,asker:'Writer',text:'Choose the release day',at:new Date().toISOString(),buttons:[{id:1,label:'Tuesday',state:'pending',action:'reply',arg:''},{id:2,label:'Wednesday',state:'pending',action:'reply',arg:''}]};
            window.fetch=(u,o={})=>{
                const p=new URL(String(u),location.href).pathname;
                if(p==='/api/remote/m2/api/operator-asks')return json(window.__dismissed?[]:[window.__ask]);
                if(p==='/api/remote/m1/api/operator-asks')return json([]);
                if(p==='/api/remote/m2/api/board/same-team/asks/17/close'){
                    window.__writes.push({path:p,body:JSON.parse(o.body)});
                    if(!window.__owner)return json({error:'owner_only'},403);
                    window.__dismissed=!JSON.parse(o.body).undo;return json({ok:true});
                }
                if(p==='/api/remote/m2/api/board/same-team/asks/17/buttons/1/claim'){
                    window.__writes.push({path:p,body:JSON.parse(o.body)});
                    if(!window.__owner)return json({error:'owner_only'},403);
                    return json({action:'reply',label:'Tuesday'});
                }
                return old(u,o);
            };
        })()`});
        for(const width of [390,1280]) {
            await Emulation.setDeviceMetricsOverride({width,height:1000,deviceScaleFactor:1,mobile:width<760});
            await Emulation.setTouchEmulationEnabled({enabled:width<760});
            await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await coralReady(ev,'startup','settings');
            await ev(`window.switchNavTab('hub-inbox');import(${S}+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
            const open=async()=>{await ev(`import(${S}+'operator_ask_dialog.js').then(m=>{m.openAskDialog(window.__ask);return true})`);await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`,'question dialog');};
            await open();
            if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/hub-ask-'+width+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
            assert.equal(await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog button')].some(b=>b.textContent==='Dismiss'&&!b.hidden)`),true,width+': owner has Dismiss');
            assert.equal(await ev(`!!document.querySelector('dialog [data-button-id="1"]')`),true,'non-binary offered reply uses the source claim route');
            await ev(`[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Dismiss').click();true`);
            await waitFor(`window.__dismissed&&!document.querySelector('dialog.inbox-ask-dialog')`,'source question dismissed');
            await waitFor(`!![...document.querySelectorAll('.toast button')].find(b=>b.textContent==='Undo')`,'Undo available');
            await ev(`[...document.querySelectorAll('.toast button')].find(b=>b.textContent==='Undo').click();true`);
            await waitFor(`!window.__dismissed&&window.__writes.length===2`,'Undo restores source question');
            assert.deepEqual(await ev(`window.__writes.map(w=>w.body)`),[{note:'Dismissed by the operator'},{undo:true}]);
            await ev(`window.__owner=false;true`);await open();
            await ev(`[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Dismiss').click();true`);
            await waitFor(`/owner_only/.test(document.querySelector('.inbox-ask-error')?.textContent||'')`,'non-owner refusal');
            assert.equal(await ev(`window.__dismissed`),false,'refusal leaves question open');
            await ev(`[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Close').click();window.__owner=true;true`);
            await open();await ev(`document.querySelector('dialog [data-button-id="1"]').click();true`);
            await waitFor(`window.__writes.some(w=>w.path.endsWith('/buttons/1/claim'))&&!document.querySelector('dialog.inbox-ask-dialog')`,'offered reply reaches source');
            assert.equal(await ev(`window.__writes.every(w=>w.path.startsWith('/api/remote/m2/'))`),true,'every action stays on the question computer');
        }
        console.log('PASS Hub question dialog Dismiss/Undo, non-owner refusal, non-binary offered reply at desktop/phone');
    } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
