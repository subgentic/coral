// A task's instruction revision, its amendments and the stale-revision guards, on the team page's task page (#7644; they were the task dialog's). Stubbed board routes record every request: the page shows the revision and the
// amendment history, Edit amends with the base revision and the reason (and writes nothing else), a refusal and a stale revision say so and keep the form, a completion against a stale revision keeps the draft and offers a
// refresh and sends the revision it saw, a revision-one task completes as revision one, and a finished task has no Edit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const CDP = require('chrome-remote-interface');

const BASE = require('./test_base').BASE;

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime } = client;
    const ev = async expression => {
        const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const { waitFor } = require('./helpers/wait').bind(ev);
    const bar = () => ev(`[...document.querySelectorAll('#tp-host .goals-pinbar .btn, #tp-host .goals-pinbar [role=menuitem]')].map(b => b.textContent)`);
    const click = async text => { await waitFor(`[...document.querySelectorAll('#tp-host .goals-pinbar .btn, #tp-host .goals-pinbar [role=menuitem]')].some(b => b.textContent === ${JSON.stringify(text)})`, 'the ' + text + ' button'); await ev(`[...document.querySelectorAll('#tp-host .goals-pinbar .btn, #tp-host .goals-pinbar [role=menuitem]')].find(b => b.textContent === ${JSON.stringify(text)}).click(); true`); };
    const show = async task => { await ev(`window.__task = ${JSON.stringify(task)}; testState.currentBoardTasks = [window.__task]; document.getElementById('tp-host').replaceChildren(); testPage.renderTaskPage(document.getElementById('tp-host'), window.__task, { project: 'amendment-fixture', backLabel: 'Tasks', onBack() {}, openGoal() {} }); true`); await waitFor(`!!document.querySelector('#tp-host #team-task-title')`, 'the page'); };
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        await Page.navigate({ url: BASE }); await Page.loadEventFired();
        await ev(`(async () => {
            const {state} = await import((window.__coralStatic||'/static/')+'state.js');
            window.testPage = await import((window.__coralStatic||'/static/')+'team_tasks_page.js');
            window.testState = state; const host = document.createElement('div'); host.id = 'tp-host'; document.body.append(host);
            state.currentSession = {name:'amendment-fixture', board_project:'amendment-fixture', type:'live'}; state.selectedTeam = 'amendment-fixture';
            state.currentAgentTasks = []; state.currentSubagents = [];
            window.__requests = [];
            window.__amendMode = 'ok';
            window.__task = {id:1669,title:'Versioned task',body:'Original body',status:'in_progress',priority:'medium',assigned_to:'UI',claimed_at:'2026-09-30T07:00:00Z',revision:2,workflow:{instructions:'Original instructions',effective_instructions:'Original instructions',amendments:[{revision:2,actor:'Orchestrator',created_at:'2026-09-30T06:00:00Z',reason:'Clarify handoff',changes:{body:'Clarified body'},previous_snapshot:{body:'Original body'},effective_snapshot:{body:'Clarified body'}}]}};
            state.currentBoardTasks = [window.__task];
            window.fetch = async (url, opts={}) => {
                const body = opts.body ? JSON.parse(opts.body) : null;
                window.__requests.push({url, method:opts.method || 'GET', body});
                if (url.includes('/subscribers')) return new Response(JSON.stringify([{subscriber_id:'Operator'},{subscriber_id:'UI'}]), {status:200});
                if (String(url).split('?')[0].endsWith('/tasks') && (!opts.method || opts.method === 'GET')) return new Response(JSON.stringify({tasks:state.currentBoardTasks}), {status:200});
                if (/\\/tasks\\/\\d+$/.test(String(url).split('?')[0]) && (!opts.method || opts.method === 'GET')) return new Response(JSON.stringify(window.__task), {status:200});
                if (url.endsWith('/amend')) {
                    if (window.__amendMode === 'forbidden') return new Response(JSON.stringify({error:'planner authorization required'}), {status:403});
                    if (window.__amendMode === 'conflict') return new Response(JSON.stringify({error:'task revision is stale'}), {status:409});
                    return new Response(JSON.stringify(window.__task), {status:200});
                }
                if (url.includes('/complete')) return new Response(JSON.stringify({error:'task #1669 has revision 3; reread task detail before completing'}), {status:409});
                return new Response('{}', {status:200});
            };
        })()`);
        await show(JSON.parse(await ev(`JSON.stringify(window.__task)`)));

        await waitFor(`!!document.querySelector('#tp-host .team-task-extra [data-task-revision]')`, 'the revision section');
        const detail = await ev(`({text:document.querySelector('#tp-host .team-task-extra').textContent,revision:document.querySelector('[data-task-revision]')?.textContent||'',history:!!document.querySelector('#tp-host .task-amendment-history')})`);
        assert.match(detail.text, /Current revision 2/);
        assert.match(detail.text, /Clarify handoff/);
        assert.equal(detail.history, true);
        fs.writeFileSync(require('node:os').tmpdir() + '/coral-1669-task-amendment.png', Buffer.from((await Page.captureScreenshot()).data, 'base64'));

        await click('Edit'); await waitFor(`!!document.getElementById('task-edit-body')`, 'the form');
        await ev(`document.getElementById('task-edit-body').value='Amended body'; document.getElementById('task-edit-reason').value='Add acceptance detail'; true`);
        await click('Save');
        await waitFor(`window.__requests.some(r => r.url.endsWith('/amend'))`, 'the amendment request');
        const amendRequest = await ev(`window.__requests.find(r=>r.url.endsWith('/amend'))`);
        assert.equal(amendRequest.method, 'PATCH');
        assert.equal(amendRequest.body.base_revision, 2);
        assert.equal(amendRequest.body.reason, 'Add acceptance detail');
        assert.equal(amendRequest.body.changes.body, 'Amended body');
        assert.equal(amendRequest.body.changes.title, undefined);
        assert.equal(await ev(`window.__requests.some(r=>r.url.endsWith('/tasks/1669') && r.method === 'PATCH')`), false);
        await waitFor(`!document.getElementById('task-edit-body')`, 'the page again after the save');

        await click('Edit'); await waitFor(`!!document.getElementById('task-edit-body')`, 'the form again');
        await ev(`document.getElementById('task-edit-body').value='Unauthorized body'; document.getElementById('task-edit-reason').value='Unauthorized change'; window.__amendMode='forbidden'; true`);
        await click('Save');
        await waitFor(`/authorization/.test((document.getElementById('task-edit-error') || {}).textContent || '')`, 'the refusal');
        await ev(`window.__amendMode='conflict'; document.getElementById('task-edit-body').value='Stale body'; document.getElementById('task-edit-reason').value='Concurrent change'; true`);
        await click('Save');
        await waitFor(`/stale/.test((document.getElementById('task-edit-error') || {}).textContent || '')`, 'the stale revision');
        assert.equal(await ev(`document.getElementById('task-edit-body').value`), 'Stale body', 'the form keeps what was typed');
        await ev(`window.__amendMode='ok'; true`);
        await click('Cancel'); await waitFor(`!document.getElementById('task-edit-body')`, 'back on the page');

        await click('Complete'); await waitFor(`!!document.getElementById('task-complete-message')`, 'the completion form');
        await ev(`document.getElementById('task-complete-message').value='draft evidence'; true`);
        await click('Complete');
        await waitFor(`!document.getElementById('task-complete-refresh').hidden`, 'the refresh offer');
        assert.equal(await ev(`document.getElementById('task-complete-message').value`), 'draft evidence');
        const staleState = await ev(`({hidden:document.getElementById('task-complete-refresh').hidden,error:document.getElementById('task-complete-error').textContent,requests:window.__requests})`);
        assert.equal(staleState.hidden, false, JSON.stringify(staleState));
        const completeRequest = await ev(`window.__requests.find(r=>r.url.includes('/complete'))`);
        assert.equal(completeRequest.body.expected_revision, 2);

        await show({id:1670,title:'Revision one',body:'body',status:'pending',revision:1,workflow:{instructions:'instructions'}});
        await click('Complete'); await waitFor(`!!document.getElementById('task-complete-message')`, 'the form for revision one');
        await click('Complete');
        await waitFor(`window.__requests.filter(r=>r.url.includes('/complete')).length === 2`, 'the second completion request');
        const revisionOne = await ev(`window.__requests.filter(r=>r.url.includes('/complete')).at(-1).body.expected_revision`);
        assert.equal(revisionOne, 1);

        await show({id:1671,title:'Finished',status:'completed',revision:3,workflow:{instructions:'frozen'}});
        await waitFor(`!!document.querySelector('#tp-host .goals-pinbar')`, 'the bar');
        assert.equal((await bar()).includes('Edit'), false);
        console.log(JSON.stringify({revision:2, amendment:true, staleDraftPreserved:true, revisionOneCompatibility:true, terminalImmutable:true}));
    } finally { await client.close(); }
})().catch(error => { console.error(error); process.exit(1); });
