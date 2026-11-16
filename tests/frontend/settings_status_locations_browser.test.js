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
            await ev(`window.showSettingsModal('network')`);
            await waitFor(`document.querySelector('[data-cloud="hub-operator-actions"]')?.hidden===false`, 'Hub history link or list');
            await ev(`document.documentElement.dataset.theme='${theme}';document.documentElement.style.fontSize='32px';document.querySelector('[data-cloud="hub-operator-actions"]').scrollIntoView({block:'center'});true`);
            await ev(framesJs(3)); await shot(`settings-${width}-${theme}`);
            const moved = await ev(`!document.querySelector('#settings-modal #machine-health-local') && document.querySelector('[data-cloud="hub-operator-actions"]').tagName==='BUTTON'`);
            if (!moved) { missing.push(`${width}/${theme}: load/history still inline`); continue; }
            await ev(`document.querySelector('[data-cloud="hub-operator-actions"]').click()`);
            await waitFor(`document.querySelector('#computer-status-dialog li')`, 'separate history');
            assert.match(await ev(`document.querySelector('#computer-status-dialog li').textContent`), /<b>hub-user<\/b>/);
            assert.equal(await ev(`!!document.querySelector('#computer-status-dialog li b')`), false, 'Hub words remain text');
            await ev(framesJs(2)); await shot(`history-${width}-${theme}`);
            await ev(`document.getElementById('computer-status-dialog').close();window.__historyFail=true;document.querySelector('[data-cloud="hub-operator-actions"]').click()`);
            await waitFor(`document.querySelector('#computer-status-dialog [role="alert"]')`, 'read error');
            await ev(`window.__historyFail=false;document.querySelector('#computer-status-dialog .modal-body button').click()`);
            await waitFor(`document.querySelector('#computer-status-dialog li')`, 'history retry');
            await ev(`document.getElementById('computer-status-dialog').close();window.hideSettingsModal();window.__coral.toggleTopBarSettings()`);
            await waitFor(`document.querySelector('[data-on-click="m-computer-status"]')`, 'gear status entry');
            await ev(`document.querySelector('[data-on-click="m-computer-status"]').click()`);
            await waitFor(`document.querySelector('#computer-status-dialog .machine-health-card')`, 'computer status');
            await ev(framesJs(2)); await shot(`status-${width}-${theme}`);
            assert.equal(await ev(`document.querySelectorAll('#computer-status-dialog .machine-health-card').length`),1);
            assert.ok(await ev(`document.getElementById('computer-status-dialog').scrollWidth <= document.getElementById('computer-status-dialog').clientWidth+2`), 'no clipped horizontal content');
            await client.Input.dispatchKeyEvent({type:'keyDown',key:'Escape',code:'Escape'});
            await waitFor(`!document.querySelector('#computer-status-dialog[open]')`, 'Escape closes status');
        }
        assert.deepEqual(missing, [], 'Settings contains links, not load/history panels');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
