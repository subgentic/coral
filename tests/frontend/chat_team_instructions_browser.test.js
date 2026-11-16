// #16739: generated team instructions collapse without losing CLI placeholders.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const BASE=require('./test_base').BASE;
const instructions='You were automatically joined to message board "fixture". Your role is: Developer. Do NOT run coral-board join — you are already subscribed.\n\nUse the coral-board CLI to communicate with your teammates:\n'+('  coral-board read — read new messages\n'.repeat(50))+'Whenever waiting: coral-board wait --from "<name>" (or --task <id>).';
(async()=>{const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();try{
await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true});
await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();
await ev(`(()=>{localStorage.setItem('coral-live-view-mode','chat');window.__m.add('instructions','i',20,{sleeping:false});const a=window.__m.agents['instructions-id'];a.msgs[0]={type:'user',content:${JSON.stringify(instructions)}};window.selectLiveSession('instructions','claude','instructions-id','local');return true})()`);
await waitFor(`document.getElementById('live-history-messages').textContent.includes('coral-board')`,'launch prompt rendered');
await waitFor(`document.querySelectorAll('#live-history-messages .chat-bubble').length>10`,'chat loaded');
await waitFor(`(()=>{const c=document.getElementById('live-history-messages');return c.scrollHeight-c.scrollTop-c.clientHeight<50})()`,'opens at latest');
const result=await ev(`(()=>{const c=document.getElementById('live-history-messages'),d=c.querySelector('details.chat-team-instructions');return{folded:!!d&&!d.open,label:d?.querySelector('summary')?.textContent,text:d?.querySelector('pre')?.textContent}})()`);
if(process.env.CORAL_CHAT_SHOTS){const fs=require('node:fs');fs.mkdirSync(process.env.CORAL_CHAT_SHOTS,{recursive:true});fs.writeFileSync(process.env.CORAL_CHAT_SHOTS+'/latest.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
assert.equal(result.folded,true,'generated launch instructions fold by default');assert.equal(result.label,'Team instructions');assert.ok(result.text.includes('--from "<name>" (or --task <id>)'),'CLI placeholders remain visible');
await ev(`(()=>{const c=document.getElementById('live-history-messages');c.scrollTop=0;c.dispatchEvent(new Event('scroll'));return true})()`);
await waitFor(`!document.querySelector('#chat-jump-latest button').hidden`,'jump button');
assert.ok(await ev(`(()=>{const c=document.getElementById('live-history-messages').getBoundingClientRect(),b=document.querySelector('#chat-jump-latest button').getBoundingClientRect();return b.top>=c.bottom||b.left>=c.right||b.right<=c.left})()`),'jump button has space outside the text viewport');
if(process.env.CORAL_CHAT_SHOTS)require('node:fs').writeFileSync(process.env.CORAL_CHAT_SHOTS+'/folded.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
await ev(`(()=>{const d=document.querySelector('details.chat-team-instructions');d.open=true;return true})()`);
assert.equal(await ev(`document.querySelector('details.chat-team-instructions pre').textContent`),instructions);
if(process.env.CORAL_CHAT_SHOTS)require('node:fs').writeFileSync(process.env.CORAL_CHAT_SHOTS+'/expanded.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));
console.log('PASS phone team instructions, latest opening and jump gutter');
}finally{await client.close()}})().catch(e=>{console.error(e);process.exitCode=1});
