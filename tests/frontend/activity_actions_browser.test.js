// #13619: new recorded actions have words and filters at desktop and phone widths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
    const missing=[];
    try {
        await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        for(const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();
            await coralReady(ev,'startup','liveList','liveListLoaded','settings');
            await ev(`(async()=>{
                const prefix=window.__coralStatic||'/static/';
                const filters=await import(prefix+'operator_activity_filters.js');
                const priority=['answer','prompt_allow','prompt_reject','task_complete']; const actions=[...priority,...filters.ACTIONS.filter(a=>!priority.includes(a))];
                window.__activityRows=actions.map((action,i)=>({id:actions.length-i,action,item_kind:action.startsWith('task_')?'task':action.startsWith('prompt_')||action.startsWith('wait_')||action==='agents_record'?'agent':action.startsWith('file_')?'file':action.startsWith('saved_')||action==='message'?'message':action==='chat_flag'?'chat':action==='run_seen'?'run':action==='inbox_hide'?'setting':action.startsWith('goal_request_')?'goal_request':action.startsWith('goal_')?'goal':'question',item_id:['task_create','goal_create','saved_add','agents_record'].includes(action)?'':action.startsWith('file_')?'${'a'.repeat(64)}':action==='chat_flag'?'board:activity-team':action.startsWith('prompt_')||action.startsWith('wait_')?'claude-ada':'12',team:'activity-team',title:action==='answer'?'Ada':action.startsWith('task_')?'Ship release':'',note:action==='answer'?'Ship it':action==='prompt_allow'?'Yes, once':action==='prompt_reject'?'No':'',at:new Date().toISOString(),source:'local'}));
                const original=window.fetch;
                window.fetch=(url,opts)=>new URL(String(url),location.origin).pathname==='/api/activity'?Promise.resolve(new Response(JSON.stringify({actions:window.__activityRows,check:{intact:true,rows:window.__activityRows.length}}),{headers:{'Content-Type':'application/json'}})):original(url,opts);
                localStorage.removeItem('coral-inbox-activity-filters');
                window.switchNavTab('hub-inbox');
                await (await import(prefix+'inbox_sidebar.js')).openInboxGroup('activity');
            })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length===window.__activityRows.length`,'all recorded actions');
            if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/activity-actions-'+width+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
            const words=await ev(`document.querySelector('#group-table-view').textContent`);
            if(!words.includes('You answered Ada’s question: “Ship it”')) missing.push(width+': You answered Ada’s question: “Ship it”');
            if(!words.includes('You allowed claude-ada’s permission request: “Yes, once”')) missing.push(width+': You allowed claude-ada’s permission request: “Yes, once”');
            if(!words.includes('You completed task #12 Ship release')) missing.push(width+': You completed task #12 Ship release');
            const filters=await ev(`(async()=>{const p=window.__coralStatic||'/static/',a=await import(p+'inbox_activity.js'),f=await import(p+'operator_activity_filters.js');return f.ACTIONS.map(action=>[action,a.filtered({...f.EMPTY,action}).length]);})()`);
            assert.ok(filters.every(([,count])=>count===1),'every action can be filtered individually');
            const routed=await ev(`(async()=>{const p=window.__coralStatic||'/static/',a=await import(p+'inbox_activity.js'),f=await import(p+'operator_activity_filters.js');const hit=[];for(const action of ['answer','task_complete','prompt_allow','wait_dismiss','file_keep','saved_update','chat_flag','goal_edit']){const handlers=Object.fromEntries(['file','goal','question','task','agent','message','chat'].map(kind=>[kind,r=>hit.push([kind,r.action,r.item_id])]));const n=a.spec({...f.EMPTY,action},handlers).node();document.body.append(n);n.querySelector('tbody .dt-primary, tbody .dt-mail-open')?.click();n.remove();}return hit;})()`);
            assert.deepEqual(routed,[['question','answer','12'],['task','task_complete','12'],['agent','prompt_allow','claude-ada'],['agent','wait_dismiss','claude-ada'],['file','file_keep','a'.repeat(64)],['message','saved_update','12'],['chat','chat_flag','board:activity-team'],['goal','goal_edit','12']],'item controls route each new target type');
            assert.equal(await ev(`(async()=>{const p=window.__coralStatic||'/static/',a=await import(p+'inbox_activity.js'),f=await import(p+'operator_activity_filters.js');return ['task_create','goal_create','saved_add','agents_record','inbox_hide','run_seen','goal_request_accept'].every(action=>{const n=a.spec({...f.EMPTY,action},{}).node();return !n.querySelector('tbody button.dt-primary');});})()`),true,'missing or unsafe targets have no fabricated link');
            assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'no horizontal overflow');
        }
        assert.deepEqual(missing,[], 'recorded actions have plain words at both widths');
    } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
