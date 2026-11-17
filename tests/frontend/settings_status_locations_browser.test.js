// ST10: read-only computer load and Hub history have their own screens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const missing = [];
    const shot = async name => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, {recursive:true});
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        for (const width of [1440,390]) for (const theme of ['dark','light']) {
            await Emulation.setDeviceMetricsOverride({width,height:1000,deviceScaleFactor:1,mobile:width===390});
            await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const real=window.fetch; window.__historyFail=false; window.fetch=(u,o)=>{
                const path=new URL(String(u),location.origin).pathname;
                const json=(v,status=200)=>Promise.resolve(new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}}));
                if(path==='/api/cloud/status')return json({configured:true,state:'connected',hub_url:'https://hub.example',max_mode:'interact'});
                if(path==='/api/system/hub-operator')return window.__historyFail?json({},503):json({linked:true,enabled:true,disabled:false,recent_actions:[{time:'2026-11-16T05:00:00Z',method:'POST',path:'/api/board/my-team/tasks',project:'my-team',hub_user:'<b>hub-user</b>',status:200}]});
                return real(u,o);
            }; })()`);
            await ev(`(async () => { const base=window.__coralStatic || '/static/'; const {state}=await import(base+'state.js'); state.coralWs={readyState:1,send(){},close(){}}; const {applyMachineHealth}=await import(base+'machine_health.js'); applyMachineHealth({type:'coral_update',machine_health:{status:'ok',responsiveness_ms:12,coral:{cpu_percent:2,rss_bytes:104857600},agents:{count:3,cpu_percent:10,rss_bytes:536870912},host:{load1_per_core:0.25,cpu_count:8,mem_available:8589934592,mem_total:17179869184},disk:{free_bytes:107374182400,total_bytes:536870912000}}}); })()`);
            await ev(`window.showSettingsModal('network')`);
            await waitFor(`document.querySelector('[data-cloud="hub-operator-actions"]')?.hidden===false`, 'Hub history link or list');
            await ev(`document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='32px';true`);
            await ev(framesJs(3));
            await ev(`(() => { const link=document.querySelector('[data-cloud="hub-operator-actions"]'); for(let p=link;p;p=p.parentElement) if(p.tagName==='DETAILS') p.open=true; link.scrollIntoView({block:'center'}); })()`);
            await ev(framesJs(2)); await shot(`settings-${width}-${theme}`);
            const moved = await ev(`!document.querySelector('#settings-modal #machine-health-local') && document.querySelector('[data-cloud="hub-operator-actions"]').tagName==='BUTTON'`);
            if (!moved) {
                missing.push(`${width}/${theme}: load/history still inline`);
                                await ev(`document.querySelector('#machine-health-local')?.scrollIntoView({block:'center'});true`);
                await ev(framesJs(2)); await shot(`status-${width}-${theme}`);
                continue;
            }
            await ev(`document.querySelector('[data-cloud="hub-operator-actions"]').click()`);
            await waitFor(`document.querySelector('#computer-status-dialog li')`, 'separate history');
            assert.match(await ev(`document.querySelector('#computer-status-dialog li').textContent`), /<b>hub-user<\/b>/);
            assert.equal(await ev(`!!document.querySelector('#computer-status-dialog li b')`), false, 'Hub words remain text');
            await ev(framesJs(2)); await shot(`history-${width}-${theme}`);
            await ev(`document.getElementById('computer-status-dialog').close();window.__historyFail=true;document.querySelector('[data-cloud="hub-operator-actions"]').click()`);
            await waitFor(`document.querySelector('#computer-status-dialog [role="alert"]')`, 'read error');
            await ev(`window.__historyFail=false;document.querySelector('#computer-status-dialog .modal-body button').click()`);
            await waitFor(`document.querySelector('#computer-status-dialog li')`, 'history retry');
            await ev(`document.getElementById('computer-status-dialog').close();window.hideSettingsModal();document.documentElement.dataset.theme='${theme}';[...document.querySelectorAll('${width===390 ? '[data-account][aria-controls="nav-more-menu"]' : '[aria-controls="top-bar-settings-menu"]'}')].find(el=>el.checkVisibility()).click()`);
            await waitFor(`document.querySelector('[data-on-click="m-computer-status"]')?.checkVisibility()`, 'visible status entry in the desktop gear or phone account menu');
            assert.equal(await ev(`document.querySelector('[data-on-click="m-computer-status"]').checkVisibility()`),true,'status entry is reachable');
            await ev(`document.querySelector('[data-on-click="m-computer-status"]').click()`);
            await waitFor(`document.querySelector('#computer-status-dialog .machine-health-card')`, 'computer status');
            await ev(framesJs(2)); await shot(`status-${width}-${theme}`);
            assert.equal(await ev(`document.querySelectorAll('#computer-status-dialog .machine-health-card').length`),1);
            assert.ok(await ev(`(() => {const r=document.getElementById('computer-status-dialog').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && Math.abs(r.left-(innerWidth-r.width)/2)<2;})()`),'dialog is centered and inside the screen');
            assert.ok(await ev(`document.getElementById('computer-status-dialog').scrollWidth <= document.getElementById('computer-status-dialog').clientWidth+2`), 'no clipped horizontal content');
            await client.Input.dispatchKeyEvent({type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
            await client.Input.dispatchKeyEvent({type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
            await waitFor(`!document.querySelector('#computer-status-dialog')`, 'Escape closes status and finishes focus restoration');
            assert.equal(await ev(`document.activeElement?.getAttribute('aria-controls')`),width===390 ? 'nav-more-menu' : 'top-bar-settings-menu','Escape returns focus to the menu opener');
        }
        assert.deepEqual(missing, [], 'Settings contains links, not load/history panels');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
