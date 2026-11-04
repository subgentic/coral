import assert from 'node:assert/strict';
import { sendCommentQueue } from '../../coral-go/pkg/frontend/static/artifact_comment_send_queue.js';
const comments = [{id:4,artifactId:'old'}, {id:2,artifactId:'new'}, {id:9,artifactId:'new'}];
const sent = {ok:true,results:[{agent:'Dev',state:'sent'}],error:''};
let release;
const gate = new Promise(r=>release=r), calls=[], records=[];
const pending = sendCommentQueue(comments, {isCurrent:()=>true,send:async c=>{calls.push([c.artifactId,c.id]);if(c.id===4)await gate;return sent;},record:(c,r)=>records.push([c.id,r[0].state])});
await Promise.resolve();
assert.deepEqual(calls,[['old',4]],'a later thread is not sent before the earlier request finishes');
release();const done=await pending;
assert.deepEqual(calls,[['old',4],['new',2],['new',9]],'caller timeline order and each original artifact are preserved');
assert.equal(done.sentThreads,3);assert.deepEqual(records,[[4,'sent'],[2,'sent'],[9,'sent']]);
let current=true;const cancelled=[];
const stopped=await sendCommentQueue(comments,{isCurrent:()=>current,send:async c=>{cancelled.push(c.id);current=false;return sent;},record:()=>{}});
assert.equal(stopped.cancelled,true);assert.deepEqual(cancelled,[4],'closing the picker stops the next send');
const attempted=[],kept=[];
const refusal=await sendCommentQueue(comments,{isCurrent:()=>true,send:async c=>{attempted.push(c.id);return c.id===2?{ok:false,results:[{agent:'Dev',state:'paused'}],error:'Paused'}:sent;},record:(c,r)=>kept.push([c.id,r[0].state])});
assert.deepEqual(attempted,[4,2],'a refusal stops the remaining sends');assert.deepEqual(kept,[[4,'sent'],[2,'paused']]);
assert.equal(refusal.response.ok,false);assert.equal(refusal.response.error,'Paused');assert.equal(refusal.sentThreads,1);assert.equal(refusal.response.results[0].state,'paused','a later failure is visible despite an earlier successful send');
console.log('artifact_comment_send_queue: sequential order, source artifact, cancellation and partial refusal pass');

// Aggregate agent states must keep a later refusal visible and preserve a
// successful send when the next thread merely reports an existing ask.
for (const [states,expected] of [
 [['sent','already_asked'],'sent'],
 [['already_asked','sent'],'sent'],
 [['sent','paused','already_asked'],'paused'],
]) {
 let n=0;
 const result=await sendCommentQueue(comments.slice(0,states.length),{isCurrent:()=>true,send:async()=>({ok:true,results:[{agent:'Dev',state:states[n++]}]}),record:()=>{}});
 assert.equal(result.response.results[0].state,expected,'merge '+states.join(' -> '));
}
