// #17188: a real mock-agent holds its trust screen before hooks/first turn.
// Team header, agent row and goal page identify the member and link to the live prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
if (process.platform === 'win32') { console.log('team_startup_prompt_browser: SKIPPED (POSIX CLI wrapper)'); process.exit(0); }
(async () => {
    const client = await CDP({port:Number(process.env.CDP_PORT||9222)});
    const {Page,Runtime,Emulation}=client;
    await Promise.all([Page.enable(),Runtime.enable()]);
    const ev=async expression=>{const r=await Runtime.evaluate({expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const {waitFor,coralReady}=require('./helpers/wait').bind(ev);
    const api=(method,p,body)=>ev(`fetch(${JSON.stringify(p)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body===undefined?'undefined':JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,data:await r.json().catch(()=>null)}))`);
    const shot=require('./helpers/scene_shots')(Page);
    let original,agent,team='',dir='';
    try {
        await Emulation.setDeviceMetricsOverride({width:1366,height:768,deviceScaleFactor:1,mobile:false});
        await Page.navigate({url:BASE});await Page.loadEventFired();await coralReady();
        original=(await api('GET','/api/settings')).data.settings;
        if(!original)original=(await api('GET','/api/settings')).data;
        dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'coral-startup-')));
        const cli=path.join(dir,'claude');
        fs.writeFileSync(cli,`#!/bin/sh\nMOCK_AGENT_READY=1 MOCK_AGENT_STARTUP_PROMPT=trust exec '${String(original.cli_path_claude).replace(/'/g,"'\\''")}' "$@"\n`,{mode:0o755});
        assert.equal((await api('PUT','/api/settings',{cli_path_claude:cli})).status,200);
        const launched=await api('POST','/api/sessions/launch',{working_dir:dir,agent_type:'claude',display_name:'Lead Developer',board_name:'startup-'+Date.now()});
        assert.ok(launched.status<300,JSON.stringify(launched));
        await waitFor(`(window._coralGetLiveSessions?.()||[]).some(s=>s.working_directory===${JSON.stringify(dir)}&&s.waiting_kind==='startup')`,'real trust screen in live feed',{timeout:40000});
        agent=await ev(`window._coralGetLiveSessions().find(s=>s.working_directory===${JSON.stringify(dir)})`);team=agent.board_project;
        assert.equal(agent.waiting_reason,'startup_trust');assert.match(agent.waiting_summary,/trust/i);
        const goal=await api('POST',`/api/board/${encodeURIComponent(team)}/goals`,{title:'Build the site',outcome:'A working site',created_by:'Operator'});
        assert.ok(goal.status<300,JSON.stringify(goal));const goalId=goal.data.id||goal.data.goal?.id;
        await ev(`window.openTeamPage(${JSON.stringify(team)},{tab:'agents'}).then(()=>true)`);
        await waitFor(`document.querySelector('#team-page-head [data-team-startup]')?.textContent.includes('Lead Developer')`,'team header names startup wait',{timeout:10000});
        assert.match(await ev(`document.querySelector('#team-page-head [data-team-startup]').textContent`),/trust/i);
        assert.match(await ev(`document.querySelector('#live-sessions-list [data-session-id="${agent.session_id}"]').textContent`),/trust/i,'agent row gives the question');
        assert.match(await ev(`Array.from(document.querySelectorAll('tbody tr')).find(r=>r.textContent.includes('Lead Developer'))?.textContent || ''`),/trust/i,'team table gives the startup question');
        await shot('team-startup-header');
        await ev(`window.openTeamPage(${JSON.stringify(team)},{tab:'goals',item:${goalId}}).then(()=>true)`);
        await waitFor(`document.querySelector('.goal-main [data-team-startup]')?.textContent.includes('Lead Developer')`,'goal page names startup wait',{timeout:10000});
        await shot('team-startup-goal');
        await ev(`document.querySelector('.goal-main [data-team-startup] button').click(); true`);
        await waitFor(`document.querySelector('.chat-needs-input')?.textContent.includes('trust') || document.querySelector('.cni-card')?.textContent.includes('trust')`,'one click opens real prompt',{timeout:15000});
        await shot('team-startup-answer');
        await waitFor(`!!document.querySelector('.chat-needs-input .cni-answer[data-n="2"]')`,'No option belongs to live prompt',{timeout:10000});
        await ev(`document.querySelector('.chat-needs-input .cni-answer[data-n="2"]').click(); true`);
        await waitFor(`!(window._coralGetLiveSessions?.()||[]).some(s=>s.session_id===${JSON.stringify(agent.session_id)}&&s.waiting_for_input)`,'answered startup wait clears from feed',{timeout:20000});
        await ev(`window.openTeamPage(${JSON.stringify(team)},{tab:'agents'}).then(()=>true)`);
        assert.equal(await ev(`!!document.querySelector('#team-page-head [data-team-startup]:not([hidden])')`),false,'team header clears after the answer');
        console.log('PASS real startup trust prompt: team header, agent row, goal page, one-click prompt access');
    } finally {
        if(!agent&&dir)agent=await ev(`(window._coralGetLiveSessions?.()||[]).find(s=>s.working_directory===${JSON.stringify(dir)})`).catch(()=>null);
        if(agent)await api('POST',`/api/sessions/live/${encodeURIComponent(agent.session_name||agent.name)}/kill`,{session_id:agent.session_id,agent_type:'claude'}).catch(()=>{});
        if(original)await api('PUT','/api/settings',{cli_path_claude:original.cli_path_claude}).catch(()=>{});
        if(team)await require('./helpers/board_cleanup').removeBoards(ev,[team]).catch(()=>{});
        await client.close();if(dir)fs.rmSync(dir,{recursive:true,force:true});
    }
})().catch(e=>{console.error(e);process.exitCode=1;});
