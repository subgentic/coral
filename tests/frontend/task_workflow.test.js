const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime } = client;
    const ev = async expression => {
        const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r.result.value;
    };
    const { waitFor } = require('./helpers/wait').bind(ev); // a poll that survives a navigation
    const clickBar = async text => { await waitFor(`[...document.querySelectorAll('#team-panel-item .goals-pinbar .btn')].some(b => b.textContent === ${JSON.stringify(text)})`, 'the ' + text + ' button'); await ev(`[...document.querySelectorAll('#team-panel-item .goals-pinbar .btn')].find(b => b.textContent === ${JSON.stringify(text)}).click(); true`); };
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        await Page.navigate({ url: BASE }); await Page.loadEventFired();
        await ev(`(async () => {
            const {state} = await import((window.__coralStatic||'/static/')+'state.js');
            const tasks = await import((window.__coralStatic||'/static/')+'tasks.js'); await (await import((window.__coralStatic||'/static/')+'lazy_panels.js')).loadTaskDetail(); /* the task dialog is a lazy module (#5364): loaded once, then its functions answer synchronously */ 
            window.testTasks = tasks;
            // #7833: this is a real board worker, so its dock creates and lists its own assigned tasks.
            const subscribed = await fetch('/api/board/workflow-browser/subscribe', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'workflow-worker',job_title:'Developer',session_name:'workflow-browser'})});
            if (!subscribed.ok) throw new Error('worker subscribe failed: ' + await subscribed.text());
            state.currentSession = {name:'workflow-browser', board_project:'workflow-browser', type:'live', board_is_orchestrator:false, board_subscriber_id:'workflow-worker'};
            await tasks.showCreateTaskModal();
            if (document.getElementById('create-task-assignee').value !== 'workflow-worker') throw new Error('new task must start assigned to the selected worker');
            document.getElementById('create-task-title').value = 'Build candidate';
            document.getElementById('create-task-workflow').value = 'Build → Test → Release';
            document.getElementById('create-task-stage').value = 'Build';
            document.getElementById('create-task-outputs').value = 'build';
            document.getElementById('create-task-instructions').value = 'Use revision-specific evidence.';
            document.getElementById('create-task-submit').click();
            for (let i = 0; i < 100 && getComputedStyle(document.getElementById('create-task-modal')).display !== 'none'; i++) await new Promise(r => setTimeout(r, 50));
            // Worker board rows live in the filtered dock view, not the old board-wide state array.
            const ownTask = [...document.querySelectorAll('#board-task-list .board-task-item[data-kind="board"]')].find(row => row.querySelector('.board-task-name')?.textContent === 'Build candidate');
            if (!ownTask) throw new Error('created task missing from the worker dock: ' + document.querySelector('#create-task-footer .sv-status').textContent);
            window.testTaskID = Number(ownTask.dataset.taskId);
            // the task's own page on the team page (#7644: the task dialog is gone for a board's task)
            window.openTeamPage('workflow-browser', { tab: 'tasks', item: window.testTaskID });
        })()`);
        await waitFor(`!!document.querySelector('#team-panel-item .team-task-extra [data-task-revision], #team-panel-item .team-task-extra .task-detail-section')`, 'the page and its workflow', { timeout: 12000 });
        assert.ok(await ev(`document.querySelector('#team-panel-item .team-task-extra').textContent.includes('Use revision-specific evidence.')`));
        assert.ok(await ev(`document.querySelector('#team-panel-item .team-task-extra').textContent.includes('Required outputs: build')`));
        await clickBar('Complete'); await waitFor(`!!document.getElementById('task-complete-message')`, 'the completion form');
        await clickBar('Complete');
        await waitFor(`/required output/i.test(document.getElementById('task-complete-error').textContent)`, 'a missing artifact is rejected');
        await ev(`document.getElementById('task-artifact-name').value = 'build';
            document.getElementById('task-artifact-content').value = '<img src=x onerror="window.artifactXSS=true">';
            document.getElementById('task-artifact-revision').value = 'rev-42'; true`);
        await clickBar('Complete');
        await waitFor(`!document.getElementById('task-complete-message') && !!document.querySelector('#team-panel-item .team-task-extra') && document.querySelector('#team-panel-item .team-task-extra').textContent.includes('rev-42')`, 'the finished page shows the artifact revision', { timeout: 12000 });
        assert.equal(await ev(`Boolean(window.artifactXSS)`), false, 'artifacts render as text');
        const result = await ev(`fetch('/api/board/workflow-browser/tasks/' + testTaskID).then(r => r.json())`);
        assert.equal(result.workflow.outcome, 'success');
        assert.equal(result.workflow.artifacts[0].name, 'build');
        await ev(`(async()=>{
            const r=await fetch('/api/board/workflow-browser/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Missing candidate consumer',created_by:'Operator',blocked_by:[{task_id:testTaskID,required_artifacts:['candidate']}]})});
            const error=await r.json(); window.invalidDependencyError=error.error || '';
        })()`);
        // #N is the upstream task's id, which depends on what else this server has stored (#3118).
        assert.equal(await ev(`window.invalidDependencyError`), `dependency #${await ev('window.testTaskID')} cannot require artifact "candidate": upstream declares outputs [build]`);

        await ev(`(async () => {
            const {state} = await import((window.__coralStatic||'/static/')+'state.js');
            const r = await fetch('/api/sessions/launch', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({working_dir:${JSON.stringify(require('node:os').tmpdir())},agent_type:'terminal',display_name:'Personal workflow browser'})});
            if (!r.ok) throw new Error('launch failed');
            const session = await r.json();
            const resolved = await fetch('/api/sessions/'+session.session_id+'/resolve').then(r=>r.json());
            session.name = resolved.name; window.personalSession = session;
            state.currentSession = {...session,type:'live',board_project:null};
            const create = async body => {
                const r = await fetch('/api/agent/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:session.session_id,...body})});
                if (!r.ok) throw new Error(await r.text()); return r.json();
            };
            const build = await create({title:'Personal build',workflow:{required_outputs:['build']}});
            const test = await create({title:'Personal test',blocked_by:[build.id]});
            window.personalBuildID=build.id; window.personalTestID=test.id;
            await testTasks.loadAgentTasks(session.name,session.session_id);
            testTasks.showAgentTaskDetailModal(build.id);
            testTasks.completeAgentTask(build.id);
            document.getElementById('task-artifact-name').value='build';
            document.getElementById('task-artifact-content').value='Personal candidate';
            document.getElementById('task-artifact-revision').value='personal-browser-rev';
            await testTasks._doCompleteAgentTask(build.id);
            testTasks.showAgentTaskDetailModal(build.id);
        })()`);
        assert.ok(await ev(`document.getElementById('task-detail-content').textContent.includes('personal-browser-rev')`));
        const personal = await ev(`fetch('/api/agent/tasks/'+personalTestID+'?session_id='+personalSession.session_id).then(r=>r.json())`);
        assert.equal(personal.status, 'pending');
        await ev(`fetch('/api/sessions/live/'+encodeURIComponent(personalSession.name)+'/kill',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent_type:'terminal',session_id:personalSession.session_id})})`);
        console.log('PASS workflow creation, default instructions, required artifacts, completion, and safe rendering');
    } finally { await removeBoards(ev, ['workflow-browser']); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
