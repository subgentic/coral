// #8694: self-hosted hub Inbox folders list remote goals/tasks and open on origin.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
    try {
        await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        for(const width of [1280,390]){
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();
            await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
            await ev(`(async()=>{
                const {state}=await import((window.__coralStatic||'/static/')+'state.js');
                state.hub=true;state.servers=[{id:'local',status:'online'},{id:'box-2',status:'online'},{id:'down',status:'offline'}];
                localStorage.removeItem('coral-inbox-goals-filters');localStorage.removeItem('coral-inbox-tasks-filters');
                window.__hubReads=[];const original=fetch;
                window.fetch=(url,opts={})=>{
                    const p=new URL(String(url),location.origin).pathname;window.__hubReads.push(p);
                    const remote=p.startsWith('/api/remote/box-2/'),prefix=remote?'Remote':'Local';
                    const task={id:1,board_id:'same-team',board_label:prefix+' team',title:prefix+' task',status:'pending',priority:'medium',assigned_to:'Operator',body:prefix+' task body',updated_at:'2026-10-26T10:00:00Z'};
                    const goal={id:1,board_id:'same-team',title:prefix+' goal',state:'active',done_when:prefix+' completion',rollup:{done:0,active:0,blocked:0,queued:1}};
                    const json=body=>Promise.resolve(new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}}));
                    if(p.endsWith('/api/goals'))return json({goals:[goal]});
                    if(p.endsWith('/api/board/tasks'))return json({tasks:[task]});
                    if(p.endsWith('/api/board/same-team/tasks/1'))return json(task);
                    if(p.endsWith('/api/board/same-team/goals/1'))return json(goal);
                    if(p.endsWith('/api/board/same-team/tasks'))return json({tasks:[task]});
                    if(p.endsWith('/api/board/same-team/artifacts'))return json({artifacts:[]});
                    if(p.endsWith('/api/board/same-team/messages/all'))return json([]);
                    if(remote)return json({});
                    return original(url,opts);
                };return true;
            })()`);
            for(const kind of ['goals','tasks']){
                await ev(`window.switchNavTab('hub-inbox');true`);
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('${kind}')).then(()=>true)`);
                const title='Remote '+(kind==='goals'?'goal':'task');
                const row=`[...document.querySelectorAll('#group-table-view .dt-primary')].find(e=>e.textContent.includes('${title}'))`;
                await waitFor(`!!(${row})`,'remote '+kind+' listed');
                assert.ok(await ev(`document.getElementById('group-table-view').textContent.includes('Local ${kind==='goals'?'goal':'task'}')`),'local rows coexist');
                await ev(`(${row}).click();true`);
                const url='/inbox/'+kind+'/'+encodeURIComponent('@box-2/same-team')+'/1';
                await waitFor(`location.pathname===${JSON.stringify(url)} && document.getElementById('inbox-page')?.textContent.includes('${title}')`,'remote item opens in Inbox');
                assert.equal(await ev(`document.body.dataset.navTab`),'hub-inbox');
                assert.ok(await ev(`window.__hubReads.includes('/api/remote/box-2/api/board/same-team/${kind}/1')`),'detail fetched from source');
                assert.ok(await ev(`!window.__hubReads.some(p=>p.includes('/api/remote/down/'))`),'offline machine not read');
                await ev(`document.querySelector('#inbox-page .goals-back').click();true`);
                await waitFor(`location.pathname==='/inbox/${kind}' && !!(${row})`,'Back retains remote rows');
                console.log('PASS hub '+kind+' '+width);
            }
        }
    }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
