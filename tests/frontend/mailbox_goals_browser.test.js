// #21846: Inbox Goals is a source-qualified decision ledger. Keep real-board coverage for identity, task rollup, title sorting, search, explicit navigation, accessible names and responsive bounds.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { axName } = require('./helpers/ax_tree');
const BASE = require('./test_base').BASE;
const { ROW_WORDS } = require('./helpers/folder_rows');
const { removeBoards } = require('./helpers/board_cleanup');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const A = 'mg-a-' + Date.now().toString(36), B = 'mg-b-' + Date.now().toString(36);
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('goals')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .goal-decision-card').length >= 3`, 'the goals', 15000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        for (const b of [A, B]) assert.equal((await api('POST', `/api/board/${b}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-' + b })).status, 200);
        const mkGoal = async (b, title, outcome) => { const g = await api('POST', `/api/board/${b}/goals`, { subscriber_id: 'Operator', title, outcome, done_when: 'it is true' }); assert.equal(g.status, 201, JSON.stringify(g)); return g.body.id; };
        const g1 = await mkGoal(A, 'Ship the mailbox', 'One Inbox'), g2 = await mkGoal(A, 'Explore goals', 'Two teams'), g3 = await mkGoal(B, 'Plan the notes', 'Notes ready');
        for (const t of ['One', 'Two', 'Three']) assert.ok((await api('POST', `/api/board/${A}/tasks`, { title: t, body: 'x', created_by: 'orch', priority: 'medium', goal_id: g1 })).status < 300);

        const reportTask = (await api('GET', `/api/board/${A}/tasks`)).body.tasks.find(t => t.goal_id === g1);
        assert.ok(reportTask, 'real task for decision progress');
        assert.ok((await api('POST', `/api/board/${A}/tasks/${reportTask.id}/complete`, {subscriber_id:'orch',message:'Report ready',outcome:'success',artifacts:[{name:'report.md',content:'# Report'}]})).status < 300, 'real file for the approved decision progress words');

        // #21846 replaces the old table/mail layouts with the same goal ledger at both widths.
        for(const width of [1280,1024,390]){
            await open(width,844,width===390);
            const rows=await ev(`(()=>{return [...document.querySelectorAll('#group-table-view .goal-decision-card')].map(c=>({title:c.querySelector('.goal-decision-title').textContent,team:c.querySelector('.goal-decision-team').textContent,state:c.querySelector('.goal-decision-state').getAttribute('aria-label'),body:c.textContent}));})()`);
            const mine=rows.filter(r=>[A,B].some(t=>r.team.includes(t)));
            assert.deepEqual(mine.map(r=>r.title).sort(),['Explore goals','Plan the notes','Ship the mailbox'],'goals of both teams remain listed');
            assert.ok(mine.every(r=>r.state==='Active'),'goal state stays explicit');
            assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'ledger fits '+width);
            await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click();(()=>{const s=document.querySelector('.inbox-folder-toolbar select[id$="-sort"]');s.value='title';s.dispatchEvent(new Event('change',{bubbles:true}));})();true`);
            await waitFor(`(()=>{const t=[...document.querySelectorAll('#group-table-view .goal-decision-title')].map(e=>e.textContent);return t.length>=3&&t.every((v,i)=>!i||t[i-1].localeCompare(v)<=0)})()`,'ledger title sort replaces table State-column sort');
            assert.ok(await ev(`[...document.querySelectorAll('.view-list-item')].some(e=>/^Goals\\s*\\d+$/.test((${ROW_WORDS})(e)))`),'Goals remains a counted sidebar folder');
            await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.filterInbox('notes'))`);
            await waitFor(`document.querySelectorAll('#group-table-view .goal-decision-card').length===1&&document.querySelector('#group-table-view .goal-decision-title').textContent==='Plan the notes'`,'search narrows by goal title');
            await ev(`document.querySelector('#group-table-view .gl-goal-name').click();true`);
            await waitFor(`document.querySelector('#inbox-page #goals-detail-title')?.textContent.includes('Plan the notes')`,'explicit goal open reaches the shared Inbox goal');
            await ev(`document.querySelector('#inbox-page .goals-back').click();true`);
            await waitFor(`!!document.querySelector('#group-table-view .goal-decision-card')`,'Back returns to filtered ledger');
            await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.filterInbox(''))`);
            await waitFor(`document.querySelectorAll('#group-table-view .goal-decision-card').length>=3`,'clear search restores every goal');
            await ev(`(()=>{const c=[...document.querySelectorAll('#group-table-view .goal-decision-card')].find(c=>c.querySelector('.goal-decision-title').textContent==='Ship the mailbox'),t=c.querySelector('.goal-decision-toggle');if(t.getAttribute('aria-expanded')==='false')t.click();t.dataset.axp='with-tasks';return true;})()`);
            assert.ok(await ev(`[...document.querySelectorAll('#group-table-view .goal-decision-card')].find(c=>c.querySelector('.goal-decision-title').textContent==='Ship the mailbox').querySelector('.goal-decision-task-progress').textContent.includes('of 3 tasks done')`),'task rollup survives in the goal metadata');
            await waitFor(`(()=>{const c=document.querySelector('#group-table-view .goal-decision-card:has([data-goal-id="${g1}"])');return c && !c.querySelector('.gl-waits')})()`, 'plain task-result files contribute no approval counters');
            if(width===390){
                const targets=await ev(`(()=>{return [...document.querySelectorAll('#group-table-view .goal-decision-toggle')].map(t=>{const r=t.getBoundingClientRect();return {name:t.getAttribute('aria-label'),height:r.height,width:r.width}})})()`);
                assert.ok(targets.length>=3 && targets.every(t=>t.height>=44&&t.width>=44),'every phone goal heading has a 44px tap target: '+JSON.stringify(targets));
            }
            const ax=await axName(client,'#group-table-view .goal-decision-toggle[data-goal-id="'+g1+'"]');assert.ok(ax?.name.includes('Ship the mailbox')&&ax.name.includes('Active'),'goal heading has title and state in its accessible name: '+JSON.stringify({width,ax}));
        }
        console.log('PASS Inbox goal ledger: source teams, rollup, search, navigation, accessibility and responsive bounds');
    } finally { await removeBoards(ev, [A, B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
