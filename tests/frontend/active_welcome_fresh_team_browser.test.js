// #16644: fresh real team, mock CLI; no history/live responses replaced.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {connect}=require('./agent_view_harness');
const {removeBoards,removeTeams}=require('./helpers/board_cleanup');
const BASE=require('./test_base').BASE;
if(process.platform==='win32'){console.log('SKIP shell mock wrapper');process.exit(0);}
(async()=>{
 const {client,Page,ev,waitFor}=await connect(); const {coralReady}=require('./helpers/wait').bind(ev);
 const api=(method,url,body)=>ev(`fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${body===undefined?'undefined':JSON.stringify(JSON.stringify(body))}}).then(async r=>({status:r.status,data:await r.json()}))`);
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'coral-counts-'))),board='counts-'+Date.now().toString(36);let settings,actualBoard=board; const guard=await require('./helpers/settings_guard').guardSettings();
 try{
  await Page.enable();await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await coralReady();
  const got=(await api('GET','/api/settings')).data;settings=got.settings||got;
  assert.match(settings.cli_path_claude,/mock-agent/);
  const wrapper=path.join(dir,'claude');fs.writeFileSync(wrapper,'#!/bin/sh\nMOCK_AGENT_READY=1 MOCK_AGENT_TRANSCRIPT=1 exec '+"'"+settings.cli_path_claude.replace(/'/g,"'\\''")+"'"+' "$@"\n',{mode:0o755});
  await api('PUT','/api/settings',{cli_path_claude:wrapper,inbox_welcome:'on',inbox_welcome_done:''});
  const launched=await api('POST','/api/sessions/launch-team',{board_name:board,working_dir:dir,agent_type:'claude',agents:['Orchestrator','Builder','Reviewer'].map(name=>({name,prompt:'Report ready.'}))});
  assert.equal(launched.status,200,JSON.stringify(launched.data));actualBoard=launched.data.board;console.log('LAUNCHED',JSON.stringify(launched.data));
  await waitFor(`(window._coralGetLiveSessions?.()||[]).filter(s=>s.board_project===${JSON.stringify(actualBoard)}&&!s.starting).length>=3`,'three real agents ready',30000,`fetch('/api/sessions/live').then(r=>r.json())`);for(const row of launched.data.agents){await ev(`(async()=>{await window.selectLiveSession(${JSON.stringify(row.session_name)},'claude',${JSON.stringify(row.session_id)},'');const c=await import((window.__coralStatic||'/static/')+'controls.js');document.getElementById('command-input').value='Count test ready';await c.sendCommand();return true;})()`);}
  await waitFor(`fetch('/api/sessions/history/counts').then(r=>r.json()).then(d=>d.active===3)`,'three agent transcripts indexed',45000,`fetch('/api/sessions/history?page_size=200').then(r=>r.json())`);
  await ev(`localStorage.setItem('coral.inbox.read.v1',JSON.stringify({since:Date.now()-3600000,items:{}}));true`);
  await Page.reload();await Page.loadEventFired();await coralReady();
  const result=await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'mailbox_chats.js');await m.loadChatCounts();return {active:m.chatSections()[0].items.find(x=>x.key==='chats-active'),counts:await fetch('/api/sessions/history/counts').then(r=>r.json()),history:await fetch('/api/sessions/history?page_size=200').then(r=>r.json())};})()`);
  console.log('FRESH TEAM COUNTS',JSON.stringify(result));
  const welcome=await ev(`(async()=>{const root=window.__coralStatic||'/static/';const {state}=await import(root+'state.js');const w=await import(root+'welcome_items.js');const live=state.liveSessions,settings=state.settings;state.settings={...settings,inbox_welcome:'on',inbox_welcome_done:'team'};state.liveSessions=[];const initial=w.welcomeRows().length;state.liveSessions=[{session_id:'observed-agent'}];const observed=w.welcomeRows().length;state.liveSessions=[];const after=w.welcomeRows().length;state.liveSessions=live;state.settings=settings;return {initial,observed,after};})()`);console.log('WELCOME TRANSIENT SNAPSHOT',JSON.stringify(welcome));assert.deepEqual(welcome,{initial:5,observed:4,after:4},'observed Welcome step remains done after empty live snapshot');
  assert.equal(result.active.count,3,'Active now badge counts the three agent chats, excluding board history');
 }finally{
  await removeTeams(ev,[actualBoard]);await removeBoards(ev,[actualBoard]);if(settings)await api('PUT','/api/settings',{cli_path_claude:settings.cli_path_claude,inbox_welcome:settings.inbox_welcome,inbox_welcome_done:settings.inbox_welcome_done}).catch(()=>{});await guard.restore();await client.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
