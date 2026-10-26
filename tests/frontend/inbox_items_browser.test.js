// #8633: Inbox task and Board history rows keep their reader in the Inbox.
// Real isolated board/task/message fixtures; both mounts at desktop and phone widths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const board = 'inbox-items-' + Date.now().toString(36), title = 'Read this task in the Inbox';
    const failures = [];
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,body:await r.json()}))`);
    const load = async url => {
        await Page.navigate({url:BASE+url}); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList','liveListLoaded','settings')`);
        await ev(`(() => { const s=document.createElement('style'); s.textContent='*, *::before, *::after { transition: none !important; animation: none !important; }'; document.head.append(s); return true; })()`);
    };
    const folder = async key => {
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab(${JSON.stringify(key)})).then(()=>true)`);
    };
    const row = text => `[...document.querySelectorAll('#group-table-view .dt-primary')].find(e=>e.textContent.includes(${JSON.stringify(text)}))`;
    const open = async text => {
        await waitFor(`!!(${row(text)})`, 'the Inbox row: '+text,15000);
        const p = await ev(`(() => { const e=${row(text)}; e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
        await client.Input.dispatchMouseEvent({type:'mousePressed',...p,button:'left',clickCount:1});
        await client.Input.dispatchMouseEvent({type:'mouseReleased',...p,button:'left',clickCount:1});
    };
    const shot = async name => {
        const dir=process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP,'out'));
        if (!dir) return;
        fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,name+'.png'),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
    };
    const checkInbox = async url => {
        await waitFor(`location.pathname===${JSON.stringify(url)} && document.getElementById('inbox-page')?.getClientRects().length>0`, 'item opens inside Inbox at '+url,15000);
        assert.equal(await ev(`document.body.getAttribute('data-nav-tab')`),'hub-inbox');
        assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth+1`),'no horizontal overflow');
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        await load('/');
        assert.equal((await api('POST',`/api/board/${board}/subscribe`,{subscriber_id:'orch',job_title:'Orchestrator'})).status,200);
        const made=await api('POST',`/api/board/${board}/tasks`,{created_by:'orch',assigned_to:'Operator',title,body:'The same task detail and conversation, without leaving Inbox.',priority:'medium'});
        assert.equal(made.status,201); const id=made.body.id || made.body.task.id;
        assert.equal((await api('POST',`/api/board/${board}/messages`,{subscriber_id:'orch',content:'Read this board in the Inbox'})).status,200);
        for (const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
            await Emulation.setTouchEmulationEnabled({enabled:width===390});
            for (const kind of ['tasks','boards']) {
                try {
                    const isTask=kind==='tasks', key=isTask?'tasks':'chats-group', text=isTask?title:board;
                    const url=`/inbox/${kind}/${board}${isTask?'/'+id:''}`;
                    await load('/'); await folder(key);
                    if (isTask) await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.filterInbox('Read this task'))`);
                    await open(text); await checkInbox(url); // failing-first: currently jumps to /team
                    const content=isTask?'#inbox-page .team-task-page':'#inbox-page #mb-board';
                    await waitFor(`document.querySelector(${JSON.stringify(content)})?.textContent.includes(${JSON.stringify(isTask?title:'Read this board in the Inbox')})`, 'shared item content');
                    if (width===390) assert.equal(await ev(`document.querySelector('#inbox-page select[aria-label="Inbox views"]').value`),key);
                    for (const theme of ['light','dark']) {
                        await ev(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)}); true`);
                        await shot(`inbox-${kind}-${width}-${theme}`);
                    }
                    await ev(`document.querySelector('#inbox-page .goals-back').click(); true`);
                    await waitFor(`location.pathname==='/inbox/${kind}' && !!(${row(text)})`, 'Back to originating folder');
                    if (isTask) assert.ok(await ev(`[...document.querySelectorAll('#group-table-view .dt-primary')].every(e=>e.textContent.includes('Read this task'))`),'task search retained');
                    await ev('history.forward(); true'); await checkInbox(url);
                    await load(url); await checkInbox(url);
                    await waitFor(`!!document.querySelector('#inbox-page .inbox-team-link')`, 'quiet team link');
                    const teamURL=`/team/${board}/${isTask?'tasks/'+id:'messages'}`;
                    assert.equal(await ev(`document.querySelector('#inbox-page .inbox-team-link').getAttribute('href')`),teamURL);
                    await ev(`document.querySelector('#inbox-page .inbox-team-link').click(); true`);
                    await waitFor(`location.pathname===${JSON.stringify(teamURL)} && document.getElementById('team-page-view')?.getClientRects().length>0`, 'explicit team link');
                    if (!isTask) await waitFor(`document.querySelector('#team-panel-messages #mb-board')?.textContent.includes('Read this board in the Inbox')`, 'Board mount survives transfer to team');
                    console.log(`PASS ${kind} ${width}: Inbox, Back, reload, team link`);
                } catch (error) { failures.push(`${kind} ${width}: ${error.message}`); console.error(failures.at(-1)); }
            }
        }
        assert.equal(failures.length,0,failures.join('\n'));
    } finally { await removeBoards(ev,[board]).catch(()=>{}); await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
