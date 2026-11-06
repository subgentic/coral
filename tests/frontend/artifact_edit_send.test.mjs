import assert from 'node:assert/strict';import test from 'node:test';import {installDom,importUi} from './helpers/jsdom_env.mjs';
const dom=installDom({mode:'local'});dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
const {openEditSend}=await importUi('artifact_edit_send'),{editContext}=await importUi('artifact_markdown_api'),{state}=await importUi('state');const hex='a'.repeat(64),base='b'.repeat(64),ctx=editContext('m1','dev',hex);
const until=predicate=>predicate()?Promise.resolve():new Promise((resolve,reject)=>{const timer=setTimeout(()=>{o.disconnect();reject(Error('condition not reached'));},2000);const o=new MutationObserver(()=>{if(predicate()){clearTimeout(timer);o.disconnect();resolve();}});o.observe(document.body,{subtree:true,childList:true,attributes:true});});
const cap={can_send_edit:true,base_digest:base,base_version:1,version:2,sent_to:[]};
const writer={role:'Writer',name:'A writer',agent_type:'claude',availability:'active'};
test('the picker reads the file computer/team, sends nothing on open/cancel, and does not follow selected team',async()=>{
 const calls=[];state.selectedTeam='@m2/dev';globalThis.fetch=window.fetch=async(url,options={})=>{calls.push({url:String(url),...options});return Response.json(String(url).endsWith('/edit/send')?cap:{project:'dev',agents:[writer]});};
 const h=openEditSend({context:ctx,filename:'report.md'});await until(()=>!!document.querySelector('.aes-picker input'));assert.ok(calls.every(c=>c.url.startsWith('/api/remote/m1/')));assert.equal(calls.filter(c=>c.method==='POST').length,0);assert.match(document.querySelector('.aes-status').textContent,/does not send/);document.querySelector('.artifact-edit-send-dialog .ac-cancel').click();assert.equal(document.querySelector('.artifact-edit-send-dialog'),null);assert.equal(calls.filter(c=>c.method==='POST').length,0);h.close();
});
test('only the explicit send creates a request; busy close is blocked; thread opens after confirmed result',async()=>{
 let resolveSend,posts=[],seen=0,opened=null;const pending=new Promise(r=>{resolveSend=r;});globalThis.fetch=window.fetch=async(url,options={})=>{if(options.method==='POST'){posts.push({url:String(url),...options});return pending;}return Response.json(String(url).endsWith('/edit/send')?cap:{project:'dev',agents:[writer]});};
 const h=openEditSend({context:ctx,filename:'report.md',onSent:()=>{seen++;},onThread:id=>{opened=id;}});await until(()=>!!document.querySelector('.aes-picker input'));document.querySelector('.aes-picker input').click();document.querySelector('.aes-picker .ac-ask-go').click();assert.equal(posts.length,1);assert.deepEqual(JSON.parse(posts[0].body),{agents:['Writer']});assert.equal(h.close(),false);assert.equal(h.beforeLeave(),true);assert.ok(document.querySelector('.artifact-edit-send-dialog[open]'));
 resolveSend(Response.json({ok:true,thread_id:9,limited:true,results:[{agent:'Writer',state:'sent'}]}));await until(()=>!document.querySelector('.aes-thread').hidden);assert.equal(seen,1);assert.match(document.querySelector('.aes-status').textContent,/both version links/);document.querySelector('.aes-thread').click();assert.equal(opened,9);assert.equal(document.querySelector('.artifact-edit-send-dialog'),null);assert.equal(posts.length,1);
});
test('already asked recipients cannot be selected again and unavailable roles keep their reason',async()=>{
 globalThis.fetch=window.fetch=async url=>Response.json(String(url).endsWith('/edit/send')?{...cap,sent_to:['Writer']}:{project:'dev',agents:[writer,{role:'Sleeping',agent_type:'claude',availability:'sleeping'},{role:'Terminal',agent_type:'terminal',availability:'active'}]});const h=openEditSend({context:ctx,filename:'report.md'});await until(()=>document.querySelectorAll('.aes-picker input').length===2);const all=[...document.querySelectorAll('.aes-picker input')];assert.ok(all.every(i=>i.getAttribute('aria-disabled')==='true'));assert.match(document.querySelector('.aes-picker').textContent,/Already asked/);assert.match(document.querySelector('.aes-picker').textContent,/Asleep/);all[0].click();assert.equal(document.querySelector('.ac-ask-go').disabled,true);h.close();
});

test('closing during metadata lookup ignores a late response and never fetches recipients or sends',async()=>{
 let finish;const pending=new Promise(resolve=>{finish=resolve;});const calls=[];
 globalThis.fetch=window.fetch=async(url,options={})=>{calls.push({url:String(url),...options});return pending;};
 const h=openEditSend({context:ctx,filename:'report.md'});assert.equal(h.close(),true);
 finish(Response.json(cap));await pending;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(document.querySelector('.artifact-edit-send-dialog'),null);assert.equal(calls.length,1);assert.equal(calls[0].method,undefined);
});
