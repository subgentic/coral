// Isolated browser regression: subscriber discovery must never clear assignment (the Edit form of a task's page, #7644; it was the dialog's). A form for a task is built from the subscribers read for it: a missing, failed or malformed
// answer keeps the task's assignee selected once, a title-only save writes the title (as the Operator) and no assignee, an explicit unassign or reassign writes just that, and a late answer for a form the person has left (Cancel,
// another page, another task) draws nothing over what is shown now.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const base = require('./test_base').BASE;
if (!base || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(base) || /:8420\/?$/.test(base)) throw Error('Use an isolated local server');
(async () => {
    const c = await CDP({port:Number(process.env.CDP_PORT || 9222)});
    const ev = async expression => {
        const r = await c.Runtime.evaluate({expression,returnByValue:true,awaitPromise:true});
        if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
        return r.result.value;
    };
    const { waitFor } = require('./helpers/wait').bind(ev);
    const bar = text => `[...document.querySelectorAll('#tp-host .goals-pinbar .btn, #tp-host .goals-pinbar [role=menuitem]')].find(b => b.textContent === ${JSON.stringify(text)})`;
    // the task's page in `mode` for a board; the form is async: wait for it to be there when it will be
    const show = (id, mode = 'view', project = 'fixture') => ev(`(() => { const t = s.currentBoardTasks.find(x => x.id === ${id}); testPage.renderTaskPage(document.getElementById('tp-host'), t, { project: ${JSON.stringify(project)}, backLabel: 'Tasks', onBack() {}, openGoal() {} }, ${JSON.stringify(mode)}); return true; })()`);
    const edit = async id => { await show(id); await waitFor(`!!(${bar('Edit')})`, 'the Edit button'); await ev(`(${bar('Edit')}).click(); true`); };
    try {
        await c.Page.enable(); await c.Network.enable(); await c.Network.setCacheDisabled({cacheDisabled:true});
        await c.Page.navigate({url:'about:blank'}); await c.Page.loadEventFired();
        await c.Page.navigate({url:base}); await c.Page.loadEventFired();
        await ev(`(async()=>{
            window.s=(await import((window.__coralStatic||'/static/')+'state.js')).state;
            window.testPage=await import((window.__coralStatic||'/static/')+'team_tasks_page.js');
            const host = document.createElement('div'); host.id = 'tp-host'; document.body.append(host);
            s.currentSession={name:'fixture',board_project:'fixture',type:'live'}; s.selectedTeam = 'fixture';
            s.currentBoardTasks=[{id:1,title:'Assigned task',body:'',priority:'medium',status:'pending',assigned_to:'Orchestrator',workflow:{}},
                {id:2,title:'Second task',body:'',priority:'medium',status:'pending',assigned_to:'UI',workflow:{}}];
            window.mode='missing';window.writes=[];window.pending=[];
            window.fetch=async (url,opts={})=>{
                if(opts.method==='PATCH'){writes.push({url,body:JSON.parse(opts.body)});return new Response('{}');}
                if(url.endsWith('/subscribers')){
                    if(mode==='deferred')return new Promise(resolve=>pending.push(()=>resolve(new Response('[{"subscriber_id":"Late agent"}]'))));
                    if(mode==='network')throw Error('Offline');
                    if(mode==='http')return new Response('{}',{status:503});
                    if(mode==='malformed')return new Response('{}');
                    if(mode==='present')return new Response('[{"subscriber_id":"Orchestrator"},{"subscriber_id":"Orchestrator"},{"name":"UI"}]');
                    return new Response('[{"subscriber_id":"UI"}]');
                }
                const p = String(url).split('?')[0];
                if(p.endsWith('/tasks'))return new Response(JSON.stringify({tasks:s.currentBoardTasks}));
                { const m = /\\/tasks\\/(\\d+)$/.exec(p); if (m) return new Response(JSON.stringify(s.currentBoardTasks.find(t => t.id === Number(m[1])) || {}), {status:200}); }
                return new Response('{}');
            };
        })()`);
        for (const mode of ['missing','network','http','malformed','present']) {
            await ev(`mode=${JSON.stringify(mode)};writes=[];true`);
            await edit(1);
            await waitFor(`!!document.getElementById('task-edit-assignee')`, 'the form (' + mode + ')');
            const result=await ev(`(()=>{
                const selected=document.getElementById('task-edit-assignee').value;
                const options=[...document.getElementById('task-edit-assignee').options].map(x=>x.value);
                document.getElementById('task-edit-title').value='Title only';
                return {selected,options};
            })()`);
            await ev(`(${bar('Save')}).click(); true`);
            await waitFor(`writes.length === 1`, 'the save (' + mode + ')');
            result.writes = await ev(`writes`);
            console.log(mode,JSON.stringify(result));
            assert.equal(result.selected,'Orchestrator');
            assert.equal(result.options.filter(x=>x==='Orchestrator').length,1);
            assert.deepEqual(result.writes,[{url:'/api/board/fixture/tasks/1',body:{subscriber_id:'Operator',title:'Title only'}}]);
            await waitFor(`!document.getElementById('task-edit-title')`, 'the page after the save');
        }
        for (const assignment of ['', 'UI']) {
            await ev(`mode='missing';writes=[];true`);
            await edit(1); await waitFor(`!!document.getElementById('task-edit-assignee')`, 'the form');
            await ev(`document.getElementById('task-edit-assignee').value=${JSON.stringify(assignment)}; (${bar('Save')}).click(); true`);
            await waitFor(`writes.length === 1`, 'the save');
            assert.deepEqual(await ev(`writes`),[{url:'/api/board/fixture/tasks/1',body:{assigned_to:assignment,subscriber_id:'Operator'}}]);
            await waitFor(`!document.getElementById('task-edit-title')`, 'the page after the save');
        }
        // a late answer for a form that is no longer wanted: the newer one stays as it is
        await ev(`mode='deferred'; true`); await edit(1);
        await ev(`mode='missing'; true`); await edit(2);
        await waitFor(`!!document.getElementById('task-edit-assignee')`, 'the second task\'s form');
        await ev(`document.getElementById('task-edit-title').value='Keep my draft'; pending.shift()(); true`);
        await ev(`new Promise(r => setTimeout(r, 100))`); // sleep-ok: the late answer has nothing to signal when it is ignored
        assert.deepEqual(await ev(`({title:document.getElementById('task-edit-title').value,assigned:document.getElementById('task-edit-assignee').value})`),{title:'Keep my draft',assigned:'UI'});
        for (const action of ['cancel','leave','other task','other board']) {
            await ev(`mode='deferred';pending.length=0;true`);
            await edit(1);
            await waitFor(`pending.length === 1`, 'the subscribers read');
            if (action === 'cancel') await ev(`(${bar('Cancel')}).click(); true`);
            if (action === 'leave') await ev(`document.getElementById('tp-host').replaceChildren(); true`);
            if (action === 'other task') await show(2);
            if (action === 'other board') await show(2, 'view', 'other');
            const before = await ev(`document.getElementById('tp-host').innerHTML`);
            await ev(`pending.shift()(); new Promise(r => setTimeout(r, 100))`); // sleep-ok: the late answer has nothing to signal when it is ignored
            assert.equal(await ev(`document.getElementById('tp-host').innerHTML`) === before, true, action+' must invalidate delayed subscriber response');
        }
        console.log('PASS assignment preserved on absent/failed/malformed discovery, deduplicated options, explicit unassign/reassign, and stale form responses (Cancel, leave, another task, another board)');
    } finally {await c.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
