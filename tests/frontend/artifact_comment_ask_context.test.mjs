import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({mode:'local'});
const { registerBundled } = await importUi('import_once');
const { sendCommentQueue } = await importUi('artifact_comment_send_queue');
let controls, release, started;
const calls=[];
registerBundled({
 'artifact_comments_api.js':{listComments:async()=>({comments:[],canComment:true,canLock:true}),sendComment:async(hex,server,id,agents)=>{calls.push({hex,server,id,agents});if(id===1){started?.();await new Promise(r=>release=r);}return{ok:true,results:[{agent:'Dev',state:'sent'}],error:''};}},
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
