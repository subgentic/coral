// #20863: the side panel's animated width must not send a task to the bottom and back.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { safePaused } = require('./helpers/paused');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const board = 'preview-resize-' + Date.now().toString(36);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    try {
        let reportResizeRequest;
        const resizeRequest = new Promise(resolve => { reportResizeRequest = resolve; });
        await client.Fetch.enable({ patterns: [{ urlPattern: '*preview_resize_handles.js*' }] });
        safePaused(client, e => { reportResizeRequest(e.requestId); });
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1920, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(async () => { for (const [p,b] of [['/subscribe',{subscriber_id:'Boss',job_title:'Orchestrator'}],['/tasks',{subscriber_id:'Boss',title:'Task stays put during resize',body:'Readable task preview',assigned_to:'Boss'}]]) { const r=await fetch('/api/board/${board}'+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); if(!r.ok)throw new Error('fixture '+r.status); } })()`);
        await openBoardTasksTab({ ev, waitFor }, board);
        await waitFor(`!!document.querySelector('#board-task-list .board-task-open')`, 'task row');
        await ev(`document.querySelector('#board-task-list .board-task-open').click(); true`);
        await waitFor(`!!document.querySelector('#preview-pane .team-task-page')`, 'task preview');
        // Hold the first module response: an unready handle must not invite a lost first drag.
        const requestId = await resizeRequest;
        assert.equal(await ev(`!!document.getElementById('preview-pane-resize-handle').getClientRects().length`), false, 'handle stays hidden until attached');
        await client.Fetch.continueRequest({ requestId });
        await client.Fetch.disable();
        await ev(`document.getElementById('preview-dock-btn').click(); true`);
        await waitFor(`document.getElementById('preview-pane').parentElement.id==='preview-column'`, 'wide task column');
        await waitFor(`!!document.getElementById('preview-column-resize-handle').getClientRects().length`, 'first usable resize handle');
        const first = await ev(`(() => { const h=document.getElementById('preview-column-resize-handle').getBoundingClientRect(),c=document.getElementById('preview-column').getBoundingClientRect();return {x:h.x+h.width/2,y:h.y+h.height/2,width:c.width,hit:document.elementFromPoint(h.x+h.width/2,h.y+h.height/2)?.id}; })()`);
        console.log('first handle',JSON.stringify(first));
        for (const [type,x] of [['mousePressed',first.x],['mouseMoved',first.x+24],['mouseReleased',first.x+24]]) await client.Input.dispatchMouseEvent({type,x,y:first.y,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
        console.log('after first drag',await ev(`({width:document.getElementById('preview-column').getBoundingClientRect().width,saved:localStorage.getItem('coral-preview-column-width')})`));
        await waitFor(`Math.abs(Number(localStorage.getItem('coral-preview-column-width'))-${first.width-24})<=1&&Math.abs(document.getElementById('preview-column').getBoundingClientRect().width-${first.width-24})<=1`, 'first drag is saved');
        // Stretch the real CSS transition so fast and loaded browsers both observe its intermediate widths.
        await ev(`(() => { const side=document.getElementById('agentic-state'); side.style.transitionDuration='1s'; window.__dockMoves=[]; const observer=new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n.id==='preview-pane')window.__dockMoves.push(r.target.id);}); for(const el of [side,document.getElementById('preview-column')])observer.observe(el,{childList:true}); return true; })()`);
        for (const [width, parent, moves] of [[1280,'preview-column',[]],[1000,'agentic-state',['agentic-state']],[1920,'preview-column',['preview-column']]]) {
            await ev(`window.__dockMoves=[]; true`);
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: false });
            const sideWidth = width === 1920 ? 576 : 420;
            await waitFor(`(() => { const s=document.getElementById('agentic-state');return Math.abs(s.getBoundingClientRect().width-${sideWidth})<1&&!s.getAnimations().some(a=>a.playState==='running')&&document.getElementById('preview-pane').parentElement.id==='${parent}'; })()`, 'resize settles at ' + width, 8000);
            const seen = await ev(`({moves:window.__dockMoves,chat:document.querySelector('.live-left-column').getBoundingClientRect().width})`);
            console.log(width, JSON.stringify(seen));
            if (JSON.stringify(seen.moves)!==JSON.stringify(moves)) failures.push(width+': no intermediate dock moves: '+JSON.stringify(seen));
            if (seen.chat < 419) failures.push(width+': settled chat stays readable: '+JSON.stringify(seen));
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true}); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/preview-stable-${width}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); }
        }
        // The resize controls are loaded with the visible preview and still save keyboard changes.
        const before = await ev(`document.getElementById('preview-column').getBoundingClientRect().width`);
        await ev(`document.getElementById('preview-column-resize-handle').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})); true`);
        await waitFor(`Math.abs(document.getElementById('preview-column').getBoundingClientRect().width-${before - 24})<1`, 'keyboard resize after lazy handle setup');
        assert.equal(await ev(`Number(localStorage.getItem('coral-preview-column-width'))`), Math.round(before - 24), 'keyboard width is saved');
        assert.deepEqual(failures, []);
    } finally { await removeBoards(ev,[board]); await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
