// #17130: strict Open counts/rows/tab, and the Show kind uses the same question classification as its rows.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board='strict-open-'+Date.now().toString(36), failures=[];
    const api=(path,body)=>ev(`fetch('/api/board/${board}'+${JSON.stringify(path)},{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>{if(!r.ok)throw new Error(await r.text());return r.json();})`);
    const fresh=async width=>{await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);};
    const scenario=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.error('FAIL '+name+': '+e.message);}};
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        await fresh(1280); await api('/subscribe',{subscriber_id:'Boss',job_title:'Orchestrator'});
        for(let i=0;i<5;i++){
            const t=await api('/tasks',{title:'Finished today '+i,created_by:'Boss',assigned_to:'Boss'});
            const id=t.id||t.task.id;
            await api('/tasks/claim',{subscriber_id:'Boss',task_id:id});
            await api('/tasks/'+id+'/complete',{subscriber_id:'Boss',message:'done',outcome:'success'});
        }
        for(const width of [1280,390]) await scenario(width+' strict Open',async()=>{
            await fresh(width);
            await ev(`(()=>{const inner=window.fetch;window.fetch=async(u,o)=>{const r=await inner(u,o);const p=new URL(String(u),location.href);if(p.pathname==='/api/board/${board}/tasks'&&p.searchParams.has('counts'))r.clone().json().then(j=>{window.__taskCounts=j;});return r;};return true;})()`);
            await ev(`localStorage.setItem('coral-hide-completed','true');window.openTeamPage('${board}',{tab:'goals'}).then(()=>true)`);
            const tab=`[...document.querySelectorAll('#team-tabs-row [role=tab]')].find(b=>/^Tasks\\b/.test(b.textContent))`;
            await waitFor(`window.__taskCounts?.total_completed===5`,'counts fetched before reading Tasks');
            await ev(framesJs(2));
            assert.match(await ev(`${tab}.textContent`),/^Tasks(?:\s*0)?\s*$/,'tab excludes completed tasks before the list is read');
            await ev(`window.openTeamPage('${board}',{tab:'tasks'}).then(()=>true)`);
            await waitFor(`document.querySelector('#team-panel-tasks [data-filter="done"]')?.textContent.includes('5')`,'five Done tasks counted');
            const counts=await ev(`Object.fromEntries([...document.querySelectorAll('#team-panel-tasks [data-filter]')].map(b=>[b.dataset.filter,b.textContent.trim()]))`);
            assert.match(counts.open,/Open\s*0$/);assert.match(counts.all,/All\s*5$/);assert.match(counts.done,/Done\s*5$/);
            assert.equal(await ev(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length`),0,'Open has no Done rows');
            for(const filter of ['all','done']){
                await ev(`document.querySelector('#team-panel-tasks [data-filter="${filter}"]').click();true`);
                await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr.dt-row').length===5`,filter+' retains all five results');
            }
            await ev(`document.querySelector('#team-panel-tasks [data-filter="open"]').click();document.dispatchEvent(new CustomEvent('coral:team-sleep-changed',{detail:{team:'${board}'}}));true`);
            assert.match(await ev(`${tab}.textContent`),/^Tasks(?:\s*0)?\s*$/,'tab stays strict after list read');
        });
        const chips=`Object.fromEntries([...document.querySelectorAll('#group-table-view button.goals-chip')].map(b=>{const t=b.textContent.trim();return[t.replace(/ [0-9]+\\+?$/,''),t];}))`;
        for(const width of [1280,390]) await scenario(width+' Question kind',async()=>{
            await fresh(width);
            await ev(`(()=>{const inner=window.fetch;window.fetch=(u,o={})=>{const p=new URL(String(u&&u.url||u),location.href).pathname;
                if(p==='/api/operator-asks')return Promise.resolve(Response.json(Array.from({length:4},(_,i)=>({kind:'ask',board:'walk49-team',id:41+i,asker:'Lead',text:'@Operator Question '+(i+1)+'?',at:new Date().toISOString()}))));
                if(p==='/api/board/projects')return Promise.resolve(Response.json([]));return inner(u,o);};
                localStorage.removeItem('coral-inbox-needs-filters');T.state.liveSessions=[];T.state.servers=[];T.state.settings={...T.state.settings,inbox_welcome:'off',inbox_welcome_done:'agent,team'};return true;})()`);
            await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'operator_asks.js').then(m=>m.refreshOperatorAsks(true)).then(()=>import((window.__coralStatic||'/static/')+'inbox_tab.js')).then(m=>m.selectInboxTab('needs')).then(()=>true)`);
            await waitFor(`(${chips})['All']==='All 4'`,'four questions loaded');
            const counts=await ev(chips);assert.equal(counts.Question,'Question 4');assert.equal(counts['Needs input'],undefined,'a kind with no questions has no pill (#20148)');
            for(const [label,count] of [['Question',4],['All',4]]){
                await ev(`[...document.querySelectorAll('#group-table-view button.goals-chip')].find(b=>b.textContent.trim().startsWith('${label} ')).click();true`);
                await waitFor(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length===${count}`,label+' rows match count');
            }
        });
    } finally {await removeBoards(ev,[board]).catch(()=>{});await client.close();}
    assert.deepEqual(failures,[]);
})().catch(e=>{console.error(e);process.exitCode=1;});
