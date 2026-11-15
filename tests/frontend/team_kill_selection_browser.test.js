// #16360: the team header and Board selection follow Kill all; Escape and team actions end selection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const B = `kill-select-${Date.now().toString(36)}`, problems = [];
    const check = (ok, why) => { if (!ok) problems.push(why); };
    const selected = () => ev(`!!document.getElementById('mb-select-bar')?.getClientRects().length`);
    const select = () => ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'board_export.js');if(!m.isSelectMode())m.toggleSelectMode();return true;})()`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
        await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev,B);
        await ev(`(()=>{const original=fetch.bind(window),json=b=>Promise.resolve(new Response(JSON.stringify(b),{headers:{'Content-Type':'application/json'}}));window.__ended=false;window.__statusReads=0;window.fetch=(u,o={})=>{const p=new URL(String(u),location.origin).pathname;
            if(p==='/api/board/${B}/status'){window.__statusReads++;return json({agents:['Orchestrator','Backend Dev'].map((name,i)=>({name,subscriber_id:name,session_id:'sid-'+(i+1),availability:window.__ended?'offline':'available',open_tasks:0,tasks:[]}))});}
            if(p==='/api/sessions/live/team/${B}/kill'&&o.method==='POST'){window.__ended=true;window.__LIVE=[];window.__m.agents={};return json({ok:true,sessions_killed:2});}
            return original(u,o);};return true;})()`);
        for (const width of [1280,390]) for (const theme of ['light','dark']) {
            await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width<761});
            await ev(`document.documentElement.setAttribute('data-theme','${theme}');window.__ended=false;true`);
            await seed(ev,B); await openTeam(ev,waitFor,B); await goTab(ev,settle,'Board');
            await waitFor(`document.getElementById('mb-select-btn')?.getClientRects().length>0 || document.getElementById('mb-board')?.getClientRects().length>0`,'Board ready');
            await select();
            await client.Input.dispatchKeyEvent({type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
            await client.Input.dispatchKeyEvent({type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
            check(!await selected(),`${width}/${theme}: Escape exits Select`);
            await select();
            await ev(`window.toggleTeamSleep('another-team','sleep');true`);
            check(await selected(),`${width}/${theme}: another team's action preserves Select`);
            await ev(`window.hideConfirmModal();true`);
            for (const action of [`window.toggleTeamSleep(${JSON.stringify(B)},'sleep')`, `window.resetTeam(${JSON.stringify(B)})`, `(await import((window.__coralStatic||'/static/')+'message_board.js')).deleteTeam(${JSON.stringify(B)})`]) {
                await select();
                await ev(`(async()=>{await ${action};return true;})()`);
                check(!await selected(),`${width}/${theme}: ${action} exits Select`);
                await ev(`window.hideConfirmModal();true`);
            }
            await select();
            await ev(`(async()=>{await (await import((window.__coralStatic||'/static/')+'team_pause.js')).toggleTeamPause(${JSON.stringify(B)});return true;})()`);
            check(!await selected(),`${width}/${theme}: Pause exits Select`);
            await ev(`(async()=>{await (await import((window.__coralStatic||'/static/')+'team_pause.js')).toggleTeamPause(${JSON.stringify(B)});return true;})()`);
            await select();
            const before=await ev('window.__statusReads');
            await ev(`window.killBoard(${JSON.stringify(B)});true`);
            await waitFor(`document.getElementById('confirm-modal')?.getClientRects().length>0`,'Kill confirmation');
            await ev(`document.getElementById('confirm-modal-yes').click();true`);
            await waitFor(`window.__ended && !T.state.liveSessions.some(s=>s.board_project===${JSON.stringify(B)})`,'live rows removed');
            await settle(500);
            check(await ev('window.__statusReads')>before,`${width}/${theme}: Kill refreshes header immediately`);
            check(!await selected(),`${width}/${theme}: Kill exits Select`);
            check(await ev(`document.getElementById('team-page-status').textContent.trim()==='' && !document.querySelector('#team-page-status .team-status-dot')`),`${width}/${theme}: no redundant stopped header word`);
            check(await ev(`document.querySelector('#team-tab-agents .team-tab-count').textContent===''`),`${width}/${theme}: no running agent count`);
            await shot(`team-killed-${width}-${theme}`);
        }
        assert.deepEqual(problems,[]);
        console.log('PASS team Kill refreshes ended-team header/count; Escape and Kill leave Select at desktop/phone, light/dark');
    } finally { await removeBoards(ev,[B]).catch(()=>{}); await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
