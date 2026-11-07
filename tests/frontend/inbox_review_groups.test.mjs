import assert from 'node:assert/strict';
import test from 'node:test';
import {installDom,importUi} from './helpers/jsdom_env.mjs';
const dom=installDom();
const {arrangeReviewRows,reviewGroupLookup}=await importUi('inbox_review_groups');
const reviewGroupFor=(row,rows,...args)=>reviewGroupLookup(rows,...args)(row);
const row=(id,team,goal,starred=false)=>({session_id:id,review:{team,goal_id:goal,goal_title:'Shared title',starred,tags:[]}});
test('pins precede goal groups, which keep selected order and separate source identities',()=>{
 const a=row('a','@m1/dev',1),b=row('b','@m2/dev',1),c=row('c','@m1/dev',1),n=row('none','dev',null),p=row('pin','@m2/dev',2,true),q={session_id:'ask'};
 const input=[n,a,q,b,c,p];
 assert.deepEqual(arrangeReviewRows(input,true),[p,a,c,b,n,q]);
 assert.deepEqual(arrangeReviewRows(input,false),[p,n,a,q,b,c]);
 assert.deepEqual(input,[n,a,q,b,c,p]);
 const first=reviewGroupFor(a,input,true,()=>false,k=>k);
 assert.notEqual(first.key,reviewGroupFor(b,input,true,()=>false,k=>k).key);
 assert.match(first.label,/2 shown · 2 unread/);
 assert.match(first.label,/@m1\/dev/);
 assert.equal(reviewGroupFor(a,input,false,()=>false,k=>k),null);
 assert.match(reviewGroupFor(p,input,false,()=>false,k=>k).label,/Starred/);
});
test('single documents have a heading and read documents do not inflate unread counts',()=>{
 const a=row('a','dev',7),b=row('b','dev',7);b.review.tags=['read'];
 const g=reviewGroupFor(a,[a,b],true,r=>r.tags.includes('read'),k=>k);
 assert.match(g.label,/2 shown · 1 unread/);
 assert.match(reviewGroupFor(a,[a],true,()=>false,k=>k).label,/1 shown · 1 unread/);
});
test('header sorting retains goal dividers and pins without counting dividers as selections',async()=>{
 const DT=await importUi('data_table');
 const a=row('a','dev',1),b=row('b','dev',2),c=row('c','dev',1),pin=row('pin','dev',3,true);
 const rows=[b,c,pin,a],state=DT.tableState();
 const table=DT.dataTable({label:'Grouped reviews',rows,rowKey:r=>r.session_id,state,orderRows:list=>arrangeReviewRows(list,true),groupSorted:true,groupBy:reviewGroupLookup(rows,true,()=>false,k=>k),columns:[{key:'name',label:'Name',sort:true,sortValue:r=>r.session_id,cell:r=>r.session_id}],selectable:{actions:[]}});
 document.body.append(table.el);
 try{
  table.el.querySelector('.dt-sort').click();
  assert.deepEqual([...table.el.querySelectorAll('.dt-row')].map(r=>r.dataset.key),['pin','a','c','b']);
  assert.equal(table.el.querySelectorAll('.dt-group').length,3);
  assert.equal(table.el.querySelectorAll('.dt-group input').length,0);
 }finally{table.el.remove();}
});
test('review star writes only to the document computer, blocks double submission, and leaves failed writes unchanged',async()=>{
 const {starControl}=await importUi('artifact_star');
 const hex='a'.repeat(64),item={team:'@m1/dev',starred:false},calls=[];let release,changed=0;
 globalThis.fetch=window.fetch=async(url,opts)=>{calls.push([String(url),opts.method]);return new Promise(resolve=>{release=resolve;});};
 const button=starControl(item,{hex,name:'Report.md',reviewPin:true,onChange:()=>changed++});
 const host=document.createElement('div');let opened=0;host.addEventListener('click',()=>opened++);host.append(button);document.body.append(host);
 try{
  button.click();button.click();assert.equal(calls.length,1);assert.equal(button.disabled,true);
  assert.deepEqual(calls[0],['/api/remote/m1/api/artifacts/'+hex+'/star','PUT']);
  release(Response.json({starred:true}));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(item.starred,true);assert.equal(changed,1);assert.equal(opened,0);
  button.click();release(new Response('',{status:503}));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(item.starred,true);assert.equal(changed,1);assert.equal(button.disabled,false);
 }finally{host.remove();}
});
test('waiting rows keep a separate visible group, with pins first and attention counts independent of the read tag',async()=>{
 const {needsReviewAttention,reviewChangeLabels}=await importUi('inbox_review_state');
 const active=row('active','dev',1),waiting=row('waiting','dev',1),pin=row('pin','dev',1,true);waiting.review.tags=['for review','changes requested'];pin.review.tags=waiting.review.tags;
 const rows=[waiting,active,pin];assert.deepEqual(arrangeReviewRows(rows,true),[pin,active,waiting]);assert.deepEqual(arrangeReviewRows(rows,false),[pin,active,waiting]);
 assert.equal(needsReviewAttention(waiting.review),false);
 assert.match(reviewGroupLookup(rows,false,r=>!needsReviewAttention(r),k=>k)(waiting).label,/Waiting on agent · 1 shown · 0 unread/);
 waiting.review.new_comments=2;assert.equal(needsReviewAttention(waiting.review),true);assert.deepEqual(reviewChangeLabels(waiting.review),['2 new comments']);
 assert.equal(needsReviewAttention({tags:['read'],version:3,opened_version:1}),true);
});
test.after(()=>dom.window.close());
