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
        await ev(`(() => {const real=window.fetch,now=new Date().toISOString(),json=b=>Promise.resolve(new Response(JSON.stringify(b),{headers:{'content-type':'application/json'}}));window.fetch=(url,o={})=>{const u=new URL(String(url),location.origin),p=u.pathname;
            if(p==='/api/history-import')return json({imported:false,found:40,sources:{claude:31,codex:9},ready:true});
            if(p==='/api/sessions/history/counts')return json({all:2,group:2,starred:2,archived:2,notes:2,active:2,tags:[{id:7,name:'Planning',count:2,color:'#abc'}],by_agent_type:{claude:2,codex:2,agy:2,pi:2,opencode:2,hermes:2}});
            if(p==='/api/sessions/history')return json({sessions:[1,2].map(i=>({session_id:u.searchParams.get('type')==='group'?'board:team-'+i:'chat-'+i,type:u.searchParams.get('type')==='group'?'group':'agent',title:'Conversation '+i,display_name:'Agent '+i,agent_name:'Agent '+i,agent_type:u.searchParams.get('source_types')||'claude',source_type:u.searchParams.get('source_types')||'claude',summary:'The next release',last_timestamp:now,duration_sec:60,starred:true,archived:true,active:true,notes:'A note'})),total:2});
            if(p==='/api/team-artifacts')return json({artifacts:[1,2].map(i=>({id:String(i).repeat(64),name:'Plan '+i+'.txt',media_type:'text/plain',size:25,created_at:now,board_id:'team-a',team:'Release team',source:'upload',available:true,uri:'coral://artifacts/'+String(i).repeat(64),produced_by:'Writer',starred:true})),all:2,total:2,has_more:false,teams:[{board_id:'team-a',team:'Release team',all:2}]});
            if(p==='/api/activity')return json({actions:[1,2].map(i=>({id:i,action:'approve',item_kind:'goal',item_id:String(i),team:'team-a',title:'Goal '+i,at:now,source:'local'})),check:{intact:true,rows:2},has_more:false});
            return real(url,o);};return true;})()`);
        await ev(`window.switchNavTab('hub-inbox');true`);
        const folders=['needs','tasks','goals','saved','artifacts','activity','chats','chats-group','chats-notes','chats-starred','chats-active','chats-archived',...['claude','codex','agy','pi','opencode','hermes'].map(cli=>'chats-cli-'+cli),'chats-tag-7'];
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
        await waitFor(`document.querySelector('.view-list-item[data-key="chats-tag-7"]')`, 'the tag folder is drawn');
        const drawn=await ev(`[...new Set([...document.querySelectorAll('.view-list-item[data-key]')].map(e=>e.dataset.key))].filter(k=>!k.startsWith('board:'))`);
        assert.ok(drawn.every(key=>folders.includes(key)), 'cover every phone Inbox folder: '+JSON.stringify(drawn));
        for(const folder of folders) {
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('${folder}')).then(()=>true)`);
            await waitFor(`document.querySelector('#group-table-view[data-group="hub-inbox:${folder}"] tbody tr.dt-row')`,folder+' rows');
            if(folder==='chats'){await ev(`import((window.__coralStatic||'/static/')+'chat_import.js').then(m=>m.loadImportOffer()).then(()=>true)`);await waitFor(`document.querySelector('#group-table-view .chat-import-line button')`,'All chats import offer is drawn');}
            for(const theme of ['dark','light'])for(const font of [16,32])for(const inset of [0,34]) {
                await Emulation.setSafeAreaInsetsOverride({insets:{top:0,bottom:inset,left:0,right:0}});
                await ev(`document.documentElement.setAttribute('data-theme','${theme}');document.documentElement.style.fontSize='${font}px';document.getElementById('group-table-view').scrollTop=0;true`);
                await ev(framesJs(2));
                const p=await ev(`(() => {const box=document.querySelector('#group-table-view .dt-box'),row=box.querySelector('tbody tr.dt-row'),r=row.getBoundingClientRect(),b=getComputedStyle(box),c=getComputedStyle(row),td=[...row.children].find(e=>e.getClientRects().length&&getComputedStyle(e).position!=='absolute'),t=td.getBoundingClientRect(),page=document.getElementById('group-table-view'),nav=document.querySelector('.phone-nav');return {count:box.querySelectorAll('tbody tr.dt-row').length,left:r.left,right:r.right,width:r.width,viewport:innerWidth,borderLeft:b.borderLeftWidth,borderRight:b.borderRightWidth,radius:b.borderTopLeftRadius,mail:box.classList.contains('dt-mail-on'),textLeft:t.left,icon:(()=>{const i=row.querySelector('.inbox-kind-icon');if(!i)return null;const b=i.getBoundingClientRect();return {left:b.left,right:b.right};})(),divider:c.borderBottomWidth,shadow:c.boxShadow,navPadding:parseFloat(getComputedStyle(nav).paddingBottom),pagePadding:parseFloat(getComputedStyle(page).paddingBottom),pageClient:page.clientWidth,pageScroll:page.scrollWidth,sideways:page.scrollWidth>page.clientWidth+1,importButton:(()=>{const e=page.querySelector('.chat-import-line button');if(!e)return null;const b=e.getBoundingClientRect();return {left:b.left,right:b.right,width:b.width,height:b.height,clipped:e.scrollHeight>e.clientHeight+1||e.scrollWidth>e.clientWidth+1};})()};})()`);
                const at=`${folder} ${theme} ${font}px inset ${inset}`;
                if(folder==='chats')assert.ok(p.importButton&&p.importButton.left>=0&&p.importButton.right<=390&&p.importButton.height>=44&&!p.importButton.clipped,at+' import button fits, wraps and keeps its touch target: '+JSON.stringify(p.importButton));
                if(Math.abs(p.left)>1||Math.abs(p.right-390)>1||Math.abs(p.width-390)>1)failures.push(at+' row must equal viewport: '+JSON.stringify(p));
                if(p.borderLeft!=='0px'||p.borderRight!=='0px'||p.radius!=='0px'||p.sideways)failures.push(at+' no inset card or sideways scroll: '+JSON.stringify(p));
                // #13701: Needs you reserves the kind gutter; the outer row and icon still align to the phone edge.
                if(!p.mail){const expected=folder==='needs'&&p.icon?3.5*font:16;if(Math.abs(p.textLeft-expected)>1)failures.push(at+' text inset must be '+expected+'px: '+JSON.stringify(p));if(folder==='needs'&&p.icon&&(Math.abs(p.icon.left-16)>1||p.textLeft<p.icon.right+4))failures.push(at+' icon stays at 16px and text clears its tile: '+JSON.stringify(p));}
                if(parseFloat(p.divider)===0&&p.shadow==='none'&&p.count>1&&['needs','tasks','saved'].includes(folder))failures.push(at+' keep row dividers: '+JSON.stringify(p));
                assert.equal(p.navPadding,8+inset,at+' safe-area applies');
                assert.ok(p.pagePadding>=96+inset,at+' last row clears phone controls');
                if(folder==='needs'||(inset===34))await shot(`${folder}-${theme}-${font}-${inset}`);
            }
        }
        // The import offer also fits a narrow phone and long translated words.
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('chats')).then(()=>true)`);
        await waitFor(`document.querySelector('#group-table-view .chat-import-line button')`,'narrow translated import offer');
        await Emulation.setDeviceMetricsOverride({width:320,height:844,deviceScaleFactor:1,mobile:true});
        for(const width of [272,224]){
            await ev(`(()=>{document.documentElement.style.fontSize='32px';const row=document.querySelector('#group-table-view .chat-import-line');row.parentElement.style.maxWidth='${width}px';row.querySelector('button').textContent='FrühereUnterhaltungsverläufeAusAllenArbeitsbereichenImportieren'.repeat(4);return true;})()`);await ev(framesJs(6));
            const p=await ev(`(()=>{const page=document.getElementById('group-table-view'),row=page.querySelector('.chat-import-line'),b=row.querySelector('button'),r=b.getBoundingClientRect(),q=row.getBoundingClientRect();return {width:innerWidth,row:q.width,host:row.parentElement.getBoundingClientRect().width,hostRight:row.parentElement.getBoundingClientRect().right,button:r.width,left:r.left,right:r.right,height:r.height,clipped:b.scrollWidth>b.clientWidth+1||b.scrollHeight>b.clientHeight+1,pageScroll:page.scrollWidth,pageClient:page.clientWidth};})()`);
            assert.ok(p.left>=0&&p.right<=p.hostRight+1&&p.row<=p.host+1&&p.height>=44&&!p.clipped&&p.pageScroll<=p.pageClient+1,'translated import offer fits '+width+'px container: '+JSON.stringify(p));
            await shot('translated-import-'+width);
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
