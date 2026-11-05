// #13583: question, quick replies, then a larger auto-growing composer; same before/after screenshot probe.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
 const {client, Page, Emulation, ev, waitFor, PRELOAD, install} = await connect();
 const failures = [];
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for (const width of [1280,390]) {
   await Emulation.setDeviceMetricsOverride({width,height:844,deviceScaleFactor:1,mobile:width===390});
   await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
   await ev(`import((window.__coralStatic||'/static/')+'operator_ask_dialog.js').then(m=>{m.openAskDialog({board:'design-team',asker:'Designer',kind:'ask',id:81,at:new Date().toISOString(),text:'@Operator Is this the right address?\\n\\nThe tool will ask you to confirm the server address before it starts. Choose a reply below, or describe the address you want to use.',buttons:[{id:1,label:'Yes, this address',action:'reply',state:'pending'},{id:2,label:'No',action:'reply',state:'pending'}]});return true;})`);
   await waitFor(`!!document.querySelector('.inbox-ask-dialog .ac-add-image')`,'reply attachments ready'); await ev(framesJs(2));
   if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/ask-'+width+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
   const g=await ev(`(()=>{const d=document.querySelector('.inbox-ask-dialog'),q=d.querySelector('.inbox-ask-text'),o=d.querySelector('.inbox-ask-offers'),b=d.querySelector('textarea'),r=e=>{const x=e.getBoundingClientRect();return {x:x.x,y:x.y,bottom:x.bottom,h:x.height,right:x.right}};return {inReader:!!o.closest('.inbox-ask-reading'),ordered:!!(o.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING),q:r(q),o:r(o),b:r(b),min:parseFloat(getComputedStyle(b).minHeight),font:parseFloat(getComputedStyle(b).fontSize),focused:document.activeElement===b,hint:o.textContent.includes('Replies are sent as you.'),overflow:d.scrollWidth>d.clientWidth+1};})()`);
   if(!g.inReader||!g.ordered)failures.push(width+': quick replies must follow question in reading column, before composer');
   if(!g.focused||!g.hint||g.overflow)failures.push(width+': preserve focus, sent-as-you hint and fit '+JSON.stringify(g));
   if(g.b.h<g.font*8)failures.push(width+': reply box must be several lines taller '+JSON.stringify(g.b));
   if(width===1280 ? g.o.right>g.b.x : g.o.bottom>g.b.y)failures.push(width+': visual question/choices/composer order '+JSON.stringify(g));
   await ev(`[...document.querySelectorAll('.inbox-ask-offer button')].at(-1).focus(); true`);
   await client.Input.dispatchKeyEvent({type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
   await client.Input.dispatchKeyEvent({type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
   if(!await ev(`document.activeElement===document.querySelector('.inbox-ask-box')`))failures.push(width+': Tab from final quick reply reaches the reply box');
   const growth=await ev(`(()=>{const b=document.querySelector('.inbox-ask-box'),before=b.getBoundingClientRect().height;b.value=('A line of the reply\\n').repeat(20);b.dispatchEvent(new Event('input',{bubbles:true}));return {before,after:b.getBoundingClientRect().height};})()`);
   if(growth.after<=growth.before)failures.push(width+': textarea still grows with text');
   await client.Input.dispatchKeyEvent({type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
   await client.Input.dispatchKeyEvent({type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  }
  assert.deepEqual(failures,[],failures.join('\n'));
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
