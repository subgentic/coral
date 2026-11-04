import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({mode:'local'});
const { registerBundled } = await importUi('import_once');
const { sendCommentQueue } = await importUi('artifact_comment_send_queue');
let controls, release, started;
const calls=[];
registerBundled({
 'artifact_comments_api.js':{listComments:async()=>({comments:[],canComment:true,canLock:true}),sendComment:async(hex,server,id,agents)=>{calls.push({hex,server,id,agents:[...agents]});if(id===1){started?.();await new Promise(r=>release=r);}return{ok:true,results:[{agent:'Dev',state:'sent'}],error:''};}},
 'artifact_comment_send.js':{MAX_AGENTS:10,pickableAgents:()=>[],askedWords:()=>'',buildSendBlock:args=>{controls=args;const e=document.createElement('div');e.className='ac-ask';return e;}},
 'artifact_comment_send_queue.js':{sendCommentQueue},
 'agent_link.js':{agentLink:()=>document.createElement('a')},
 'team_availability.js':{refreshTeamAvailability:async()=>({agents:[]})},
});
const {state}=await importUi('state');state.servers=[{id:'A',owner_stamp:true},{id:'B',owner_stamp:true}];
const {createAsk}=await importUi('artifact_comment_ask');
let st,ask;
registerBundled({'artifact_comment_ask.js':{createAsk:opts=>{st=opts.st;ask=createAsk(opts);return ask;}}});
const {attachComments}=await importUi('artifact_comments');
for(const change of ['computer','team','file','same context','open only']) {
 const dialog=document.createElement('div'),body=document.createElement('div'),host=document.createElement('div');dialog.append(body,host);document.body.append(dialog);
 const panel=attachComments(dialog,body,host);panel.open('current','A','team-a');st.data={canLock:true,comments:[]};
 const comments=[{id:1,artifactId:'earlier'},{id:2}];
 await ask.openMany(comments);st.ask.picked.add('Dev');ask.askBlock();
 const began=new Promise(r=>started=r);const before=calls.length;const pending=controls.onSend();await began;
 if(change!=='open only')panel.close();
 panel.open(change==='file'?'different':'current',change==='computer'?'B':'A',change==='team'?'team-b':'team-a');
 release();await pending;
 assert.equal(calls.length,before+1,change+': queued second write cancelled');
 assert.deepEqual(calls[before],{hex:'earlier',server:'A',id:1,agents:['Dev']},'original artifact/computer captured');
 assert.equal(ask.askedNow(1).size,0,change+': stale response cannot record in reopened panel');
 assert.equal(dialog.querySelector('.ac-live').textContent,'',change+': stale response cannot announce success');
 panel.close();dialog.remove();
}
console.log('artifact_comment_ask_context: deferred caller sends stop on computer/team/file changes and same-context reopen');
// Two callers awaiting the same lazy video import attach only once.
let attached=0;
registerBundled({'artifact_video_comments.js':{videoTime:String,attachVideoComments:()=>{attached++;return{update(){},close(){}};}}});
const dialog=document.createElement('div'),body=document.createElement('div'),host=document.createElement('div');
body.append(document.createElement('video'));dialog.append(body,host);document.body.append(dialog);
const panel=attachComments(dialog,body,host);panel.open('current','A','team-a');
await Promise.all([panel.docWhole(),panel.docWhole()]);
assert.equal(attached,1,'concurrent docWhole attaches the lazy video module once');
panel.close();dialog.remove();

// Positive path: a stable context sends the second thread, using the picker-time
// artifact IDs and the send-time agents snapshot despite later picker edits.
{
 const dialog=document.createElement('div'),body=document.createElement('div'),host=document.createElement('div');dialog.append(body,host);document.body.append(dialog);
 const panel=attachComments(dialog,body,host);panel.open('current','A','team-a');st.data={canLock:true,comments:[]};
 const comments=[{id:1,artifactId:'first-original'},{id:2,artifactId:'second-original'}];
 const nativeTimeout=globalThis.setTimeout,timers=[];
 globalThis.setTimeout=(fn,...args)=>{const timer=nativeTimeout(fn,...args);timers.push(timer);return timer;};
 try {
  await ask.openMany(comments);st.ask.picked.add('Dev');ask.askBlock();
  const context=[st.hex,st.server,st.board,st.lifetime],before=calls.length;
  const began=new Promise(r=>started=r),pending=controls.onSend();await began;
  assert.deepEqual(calls.slice(before),[{hex:'first-original',server:'A',id:1,agents:['Dev']}],'first original thread sent to the captured computer');
  st.ask.picked.clear();st.ask.picked.add('Different agent');
  comments[1].artifactId='changed-after-picker-open';
  release();await pending;
  assert.deepEqual([st.hex,st.server,st.board,st.lifetime],context,'the context stays current so cancellation cannot hide a wrong second request');
  assert.deepEqual(calls.slice(before),[
   {hex:'first-original',server:'A',id:1,agents:['Dev']},
   {hex:'second-original',server:'A',id:2,agents:['Dev']},
  ],'both writes use the same captured computer, each original artifact, and the original picked agents');
  assert.equal(ask.askedNow(1).get('dev'),'Asked just now');
  assert.equal(ask.askedNow(2).get('dev'),'Asked just now');
  assert.match(dialog.querySelector('.ac-live').textContent,/Sent 2 of 2 comments/);
 } finally {for(const timer of timers)clearTimeout(timer);globalThis.setTimeout=nativeTimeout;panel.close();dialog.remove();}
}
console.log('artifact_comment_ask_context: stable-context second write pins destination, per-thread artifacts and selected agents');
