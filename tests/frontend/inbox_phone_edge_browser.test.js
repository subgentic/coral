// #12957: native Inbox lists use the phone viewport width, with dividers and an
// internal 16px text inset. Themes, text sizes, safe areas, and desktop guard.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const shot = async name => { const dir=process.env.CORAL_SCREENSHOT_DIR;if(!dir)return;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(`${dir}/${name}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
    try {
        await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true});
        await Emulation.setTouchEmulationEnabled({enabled:true});
        await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);await ev(INBOX_WORLD);
        await ev(`(() => {const real=window.fetch;window.fetch=(u,o={})=>new URL(String(u),location.origin).pathname==='/api/goals'?Promise.resolve(new Response(JSON.stringify({goals:[88,89].map(id=>({id,board_id:'team-a',title:'Ship the completed release',done_when:'All checks pass',state:'active',rollup:{done:2},updated_at:'2026-11-01T00:00:00Z'}))}),{headers:{'content-type':'application/json'}})):real(u,o);T.state.liveSessions=[];return true;})()`);
        await ev(`window.switchNavTab('hub-inbox');true`);
        for(const folder of ['needs','tasks','goals','saved']) {
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('${folder}')).then(()=>true)`);
            await waitFor(`document.querySelector('#group-table-view tbody tr.dt-row')`,folder+' rows');
            for(const theme of ['dark','light'])for(const font of [16,32])for(const inset of [0,34]) {
                await Emulation.setSafeAreaInsetsOverride({insets:{top:0,bottom:inset,left:0,right:0}});
                await ev(`document.documentElement.setAttribute('data-theme','${theme}');document.documentElement.style.fontSize='${font}px';document.getElementById('group-table-view').scrollTop=0;true`);
                await ev(framesJs(2));
                const p=await ev(`(() => {const box=document.querySelector('#group-table-view .dt-box'),row=box.querySelector('tbody tr.dt-row'),r=row.getBoundingClientRect(),b=getComputedStyle(box),c=getComputedStyle(row),td=[...row.children].find(e=>e.getClientRects().length&&getComputedStyle(e).position!=='absolute'),t=td.getBoundingClientRect(),page=document.getElementById('group-table-view'),nav=document.querySelector('.phone-nav');return {count:box.querySelectorAll('tbody tr.dt-row').length,left:r.left,right:r.right,width:r.width,viewport:innerWidth,borderLeft:b.borderLeftWidth,borderRight:b.borderRightWidth,radius:b.borderTopLeftRadius,mail:box.classList.contains('dt-mail-on'),textLeft:t.left,divider:c.borderBottomWidth,shadow:c.boxShadow,navPadding:parseFloat(getComputedStyle(nav).paddingBottom),pagePadding:parseFloat(getComputedStyle(page).paddingBottom),sideways:page.scrollWidth>page.clientWidth+1};})()`);
                const at=`${folder} ${theme} ${font}px inset ${inset}`;
                if(Math.abs(p.left)>1||Math.abs(p.right-390)>1||Math.abs(p.width-390)>1)failures.push(at+' row must equal viewport: '+JSON.stringify(p));
                if(p.borderLeft!=='0px'||p.borderRight!=='0px'||p.radius!=='0px'||p.sideways)failures.push(at+' no inset card or sideways scroll: '+JSON.stringify(p));
                if(!p.mail&&Math.abs(p.textLeft-16)>1)failures.push(at+' text inset must be 16px: '+JSON.stringify(p));
                if(parseFloat(p.divider)===0&&p.shadow==='none'&&p.count>1&&folder!=='goals')failures.push(at+' keep row dividers: '+JSON.stringify(p));
                assert.equal(p.navPadding,8+inset,at+' safe-area applies');
                assert.ok(p.pagePadding>=96+inset,at+' last row clears phone controls');
                await shot(`${folder}-${theme}-${font}-${inset}`);
            }
        }
        await Emulation.setSafeAreaInsetsOverride({insets:{top:0,bottom:0,left:0,right:0}});
        await Emulation.setDeviceMetricsOverride({width:1280,height:800,deviceScaleFactor:1,mobile:false});
        await Emulation.setTouchEmulationEnabled({enabled:false});
        await ev(`document.documentElement.style.fontSize='16px';import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);await ev(framesJs(2));
        const desktop=await ev(`(() => {const b=document.querySelector('#group-table-view .dt-box'),r=b.getBoundingClientRect();return {left:r.left,right:r.right,border:getComputedStyle(b).borderLeftWidth,radius:getComputedStyle(b).borderTopLeftRadius};})()`);
        assert.ok(desktop.left>320&&desktop.right<1280&&parseFloat(desktop.border)>0&&parseFloat(desktop.radius)>0,'desktop keeps its inset bordered table: '+JSON.stringify(desktop));
        await shot('desktop');
        assert.deepEqual(failures,[],failures.join('\n'));console.log('PASS inbox_phone_edge_browser');
    } finally {await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
