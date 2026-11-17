// #17325 source identity, failed append, retry, and stale query replies through the shared pager.
import assert from 'node:assert/strict';
import {installDom,importUi} from './helpers/jsdom_env.mjs';
const dom=installDom({mode:'local'});
try {
 const {state}=await importUi('state');state.hub=true;state.servers=[{id:'box',status:'online'}];
 let fail=false, release;const calls=[];
 globalThis.fetch=window.fetch=async url=>{const u=new URL(url,'http://local');calls.push(u);const p=u.searchParams;
  if(p.get('q')==='slow')await new Promise(r=>{release=r;});
  if(fail&&p.has('cursor'))return Response.json({error:'unavailable'},{status:503});
  const id=p.has('cursor')?2:1;
  return Response.json({tasks:[{id,board_id:'same',title:p.get('q')||'Task',status:'pending',assigned_to:'Operator',server:'forged',updated_at:u.pathname.includes('/box/')?'2026-11-16T12:00:00Z':'2026-11-15T12:00:00Z'}],...(id===1?{next_cursor:'next'}:{})});};
 const {createTaskQueries}=await importUi('inbox_task_pages');
 const {serverFetch}=await importUi('server_base');
 const mod=createTaskQueries((server,q,opts)=>serverFetch(server,`/api/board/tasks?${q}`,opts));
 let rows=await mod.listTasks();assert.equal(rows[0].server,'box','merged source pages retain newest-first order');assert.deepEqual(rows.map(t=>t.project).sort(),['@box/same','same']);assert.deepEqual(rows.map(t=>t.server).sort(),['box','local']);
 fail=true;rows=await mod.listTasks({append:'local'});assert.equal(rows.length,2);assert.ok(mod.taskPages().find(p=>p.server==='local').error,'failed append preserves existing rows and cursor');
 fail=false;rows=await mod.listTasks({append:'local'});assert.equal(rows.length,3);assert.equal(mod.taskPages().find(p=>p.server==='local').has_more,false);
 const slow=mod.listTasks({filters:{q:'slow',server:'local'}});await new Promise(r=>setImmediate(r));
 const fast=await mod.listTasks({filters:{q:'fast',server:'local'}});assert.equal(fast[0].title,'fast');release();await slow;
 assert.equal(mod.taskPages()[0].loadedCount,1);rows=await mod.listTasks({filters:{q:'fast',server:'local'},append:'local'});assert.ok(rows.every(t=>t.title==='fast'),'late source reply cannot replace newer query');
 assert.ok(calls.every(u=>u.searchParams.get('assigned_to')==='Operator'));console.log('PASS inbox task pages: qualified ids, failed append retry, stale query isolation');
}finally{dom.window.close();}
