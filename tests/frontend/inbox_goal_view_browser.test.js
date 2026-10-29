// #8571: the same goal detail mounts in Inbox and Team, with local Back and durable URLs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = 'goal-mount-' + Date.now().toString(36);
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({status:r.status,body:await r.json()}))`);
    const shot = async name => {
        const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out'));
        if (!dir) return;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    const load = async url => { await Page.navigate({url: BASE + url}); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        // Review captures show the final theme, never an intermediate color in its transition.
        await ev(`(() => { const style = document.createElement('style'); style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }'; document.head.append(style); return true; })()`);
    };
    const clickGoal = async mount => {
        const point = await ev(`(() => { const row = [...document.querySelectorAll('${mount} .dt-primary')].find(e=>(e.querySelector('.dt-mail-title')||e).textContent==='Keep this goal in the Inbox'); const r = row.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
        await client.Input.dispatchMouseEvent({type:'mousePressed',...point,button:'left',clickCount:1});
        await client.Input.dispatchMouseEvent({type:'mouseReleased',...point,button:'left',clickCount:1});
    };
    const detail = mount => waitFor(`!!document.querySelector('${mount} #goals-detail-title') && document.querySelector('${mount} .goal-side-group')?.textContent === 'Open 1'`, 'goal and task loaded', 15000);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        await load('/');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, {subscriber_id:'orch',job_title:'Orchestrator',session_name:board})).status,200);
        const created = await api('POST', `/api/board/${board}/goals`, {subscriber_id:'Operator',title:'Keep this goal in the Inbox',outcome:'One shared goal view',done_when:'Back returns to the filtered list'});
        assert.equal(created.status,201); const id = created.body.id;
        assert.equal((await api('PATCH', `/api/board/${board}/goals/${id}`, {subscriber_id:'Operator',state:'active'})).status,200);
        const task = await api('POST', `/api/board/${board}/tasks`, {created_by:'orch',title:'Verify both mounts',body:'Test task navigation',priority:'medium',goal_id:id});
        assert.ok(task.status < 300); const taskId = task.body.id || task.body.task.id;
        const url = `/inbox/goals/${board}/${id}`;
        for (const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            await Emulation.setTouchEmulationEnabled({enabled:width===390});
            await load('/');
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('goals')).then(()=>true)`);
            await waitFor(`[...document.querySelectorAll('#group-table-view .dt-primary')].some(e=>(e.querySelector('.dt-mail-title')||e).textContent==='Keep this goal in the Inbox')`, 'Inbox goal row',15000);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.filterInbox('Keep this goal'))`);
            await clickGoal('#group-table-view');
            await detail('#inbox-page'); // fails before #8571: the row leaves Inbox for the team page
            assert.equal(await ev(`document.body.getAttribute('data-nav-tab')`),'hub-inbox');
            assert.equal(await ev(`getComputedStyle(document.querySelector('#inbox-page #goals-detail-title')).outlineStyle`),'none','pointer arrival has no ring around the title');
            assert.equal(await ev('location.pathname'),url);
            assert.equal(await ev(`document.querySelector('#inbox-page .goals-facts').textContent`),'OutcomeOne shared goal viewDone whenBack returns to the filtered list');
            assert.equal(await ev(`document.querySelectorAll('#inbox-page .goal-team-link').length`),1);
            assert.ok(await ev(`document.querySelector('#inbox-page .goal-team-link').getAttribute('aria-label').includes(${JSON.stringify(board)})`));
            if (width===390) assert.equal(await ev(`document.querySelector('#inbox-page .view-list-item[aria-current="true"]').dataset.key`),'goals'); // a phone's folders are a drawer (#9545): the open folder is the current item
            for (const theme of ['light','dark']) {
                await ev(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)}); true`);
                assert.ok(await ev('document.documentElement.scrollWidth <= innerWidth + 1'),'no horizontal overflow');
                const track = await ev(`(() => {
                    const bar = document.querySelector('#inbox-page .goal-rollup'), s = getComputedStyle(bar);
                    const luminance = color => color.match(/[\\d.]+/g).slice(0,3).map(Number).map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((n,v,i) => n+v*[.2126,.7152,.0722][i],0);
                    const edge = luminance(s.borderTopColor), back = luminance(getComputedStyle(document.body).backgroundColor);
                    return { width:s.borderTopWidth, style:s.borderTopStyle, contrast:(Math.max(edge,back)+.05)/(Math.min(edge,back)+.05) };
                })()`);
                assert.equal(track.width,'1px','the goal track has a visible edge');
                assert.equal(track.style,'solid');
                assert.ok(track.contrast >= 3, `${theme} goal track edge contrasts at least 3:1 with the page: ${track.contrast}`);
                await shot(`inbox-goal-${width}-${theme}`);
            }
            await client.Input.dispatchKeyEvent({type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
            await client.Input.dispatchKeyEvent({type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
            assert.equal(await ev(`document.getElementById('inbox-view').hasAttribute('data-quiet-focus')`),false,'keyboard use restores visible focus');
            await ev(`document.querySelector('#inbox-page .goal-main .goals-back').click(); true`);
            await waitFor(`!!document.querySelector('#group-table-view .dt-primary') && location.pathname==='/inbox/goals'`, 'Back to Goals folder');
            assert.ok(await ev(`[...document.querySelectorAll('#group-table-view .dt-primary')].every(e=>/Keep this goal/.test(e.textContent))`),'search retained');
            await ev('history.forward(); true');
            await detail('#inbox-page');
            await load(url); await detail('#inbox-page');
            assert.equal(await ev(`document.body.getAttribute('data-nav-tab')`),'hub-inbox','reload keeps Inbox');
            if (width===390) { // a phone: a click previews the task over the list, Back returns to the list (#8914)
                await ev(`document.querySelector('#inbox-page .goal-list .dt-primary').click(); true`);
                await waitFor(`document.querySelector('#inbox-page .goal-detail-pane')?.getClientRects().length>0`, 'the preview covers the list');
                await ev(`document.querySelector('#inbox-page .goal-detail-pane .detail-back').click(); true`);
                await waitFor(`document.querySelector('#inbox-page .goal-detail-pane')?.hidden===true && document.querySelector('#inbox-page .goal-main').getClientRects().length>0`, 'Back shows the list again');
            }
            await ev(`document.querySelector('#inbox-page .goal-list .dt-primary').click(); true`);
            await waitFor(`!![...document.querySelectorAll('#inbox-page .goal-detail-pane button')].find(b => b.textContent.trim() === 'Open task page')`, 'the preview');
            await ev(`[...document.querySelectorAll('#inbox-page .goal-detail-pane button')].find(b => b.textContent.trim() === 'Open task page').click(); true`);
            await waitFor(`location.pathname===${JSON.stringify(`/inbox/tasks/${board}/${taskId}`)} && !!document.querySelector('#inbox-page .team-task-page')`, 'a task of the goal opens in the Inbox (#8861), not on the team page');
            assert.equal(await ev(`document.querySelector('#inbox-page .goals-back').textContent.trim()`),'\u2190 Keep this goal in the I\u2026','the task opened from a goal says that goal (cut at 24 characters)');
            await shot(`inbox-goal-task-${width}`);
            await ev(`document.querySelector('#inbox-page .goals-back').click(); true`); // Back returns to the goal it was opened from, not the folder
            await waitFor(`location.pathname===${JSON.stringify(url)} && document.querySelector('#inbox-page #goals-detail-title')?.textContent==='Keep this goal in the Inbox'`, 'Back returns to the goal (#8861)', 10000);
            await shot(`inbox-goal-task-back-${width}`);
            await load(`/team/${board}/goals`);
            await waitFor(`[...document.querySelectorAll('#team-panel-goals .dt-primary')].some(e=>(e.querySelector('.dt-mail-title')||e).textContent==='Keep this goal in the Inbox')`, 'team goal row');
            await clickGoal('#team-panel-goals'); await detail('#team-panel-goals');
            await ev(`document.documentElement.setAttribute('data-theme','dark'); true`);
            assert.equal(await ev(`document.querySelectorAll('#team-panel-goals .goal-team-link').length`),0);
            assert.equal(await ev(`document.querySelector('#team-panel-goals .goals-facts').textContent`),'OutcomeOne shared goal viewDone whenBack returns to the filtered list');
            await shot(`team-goal-${width}-dark`);
            await ev(`document.querySelector('#team-panel-goals .goal-main .goals-back').click(); true`);
            await waitFor(`location.pathname===${JSON.stringify(`/team/${board}/goals`)} && !!document.querySelector('#team-panel-goals .dt-primary')`, 'team Back to Goals');
        }
        await load(url); await detail('#inbox-page');
        await ev(`document.querySelector('#inbox-page .goals-add-task').click(); true`);
        await waitFor(`document.getElementById('create-task-modal')?.getClientRects().length && document.getElementById('create-task-goal')?.value===${JSON.stringify(String(id))}`, 'Inbox Add task has the goal and its team');
        assert.ok(await ev(`document.getElementById('create-task-deps').textContent.includes('Verify both mounts')`), 'dependency picker reads this goal team');
        await ev(`document.getElementById('create-task-title').value='Created inside Inbox goal'; document.getElementById('create-task-title').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('create-task-submit').click(); true`);
        await waitFor(`!document.getElementById('create-task-modal').getClientRects().length && document.querySelector('#inbox-page .goal-side-group')?.textContent==='Open 2'`, 'task created on the Inbox goal team');
        assert.equal(await ev('location.pathname'),url,'Add task stays in Inbox');
        await ev(`document.querySelector('#inbox-page .goals-close').click(); true`);
        await waitFor(`!!document.querySelector('.goals-close-dialog[open]')`, 'close goal dialog');
        await ev(`document.getElementById('goal-close-reason').value='Acceptance checked'; document.querySelector('.goals-close-dialog button[type="submit"]').click(); true`);
        await waitFor(`!!document.querySelector('#inbox-page .goals-reopen')`, 'goal closes in place');
        await ev(`document.querySelector('#inbox-page .goals-reopen').click(); true`);
        await waitFor(`!!document.querySelector('#inbox-page .goals-close')`, 'goal reopens in place');
        console.log('PASS shared goal view: Inbox/team, 1280/390, Back/search, history, reload, task navigation');
    } finally { await removeBoards(ev,[board]).catch(()=>{}); await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
