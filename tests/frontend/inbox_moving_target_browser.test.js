// #16616: a press must not activate a control that reflows during the gesture.
const assert=require('node:assert/strict');
const {connect}=require('./agent_view_harness');
const {coralReady,framesJs}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
// #18532: a redelivered click is queued (setTimeout 0 after the lift); read 'not activated' only after it could have landed, or a broken guard passes
const later=ev=>ev(framesJs(3));
(async()=>{const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();try{
 await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
 for(const width of [1280,390]){
 await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
 await ev(`window.switchNavTab('hub-inbox');true`);
 await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(()=>true)`);
 await waitFor(`document.body.dataset.navTab==='hub-inbox' && !!document.getElementById('group-table-view')`,'Inbox navigation and list');
 await ev(`(()=>{const host=document.createElement('div');host.className='team-needs-body';document.body.append(host);const b=document.createElement('button');b.id='moving-card-action';b.textContent='Open agent';b.style.cssText='transition:none!important;position:fixed;left:40px;top:160px;width:240px;height:70px;z-index:99999';window.__opened=0;window.__pressTrace=[];for(const type of ['pointerdown','click'])document.addEventListener(type,e=>window.__pressTrace.push({type,button:e.button,primary:e.isPrimary,detail:e.detail,at:e.timeStamp,nav:document.body.dataset.navTab,target:e.target.id,y:e.target.getBoundingClientRect().y}),true);b.addEventListener('click',()=>window.__opened++);host.append(b);return true})()`);
 const mouse=client.Input;
 await mouse.dispatchMouseEvent({type:'mousePressed',x:120,y:190,button:'left',clickCount:1});
 await ev(`document.getElementById('moving-card-action').style.setProperty('top','180px','important');true`);
 await waitFor(`document.getElementById('moving-card-action').getBoundingClientRect().y===180`,'control actually moved during press');
 await mouse.dispatchMouseEvent({type:'mouseReleased',x:120,y:190,button:'left',clickCount:1});
 await later(ev);
 assert.equal(await ev(`window.__opened`),0,`${width}: moving Inbox target must not activate: ${JSON.stringify(await ev('window.__pressTrace'))}`);
 await mouse.dispatchMouseEvent({type:'mousePressed',x:120,y:210,button:'left',clickCount:1});
 await mouse.dispatchMouseEvent({type:'mouseReleased',x:120,y:210,button:'left',clickCount:1});
 assert.equal(await ev(`window.__opened`),1,'deliberate stable click works: '+JSON.stringify(await ev('window.__pressTrace.slice(-3)'))+' '+JSON.stringify(await ev(`(()=>{const c=document.getElementById(\'moving-card-action\'),p=document.elementFromPoint(120,210);return {card:c&&c.getBoundingClientRect().toJSON(),conn:c&&c.isConnected,at:p&&(p.tagName+\'#\'+p.id+\'.\'+p.className)}})()`)));
 // #18397: a live redraw REPLACES the pressed control with a new node (not a move); an identical one at the same spot keeps the click, anything else does not
 const replace=(label,dy=0)=>ev(`(()=>{const old=document.getElementById('moving-card-action');const n=document.createElement('button');n.id='moving-card-action';n.textContent=${JSON.stringify(label)};n.style.cssText=old.style.cssText.replace(/top:[^;]+/,'top:'+(old.getBoundingClientRect().top+${dy})+'px');n.addEventListener('click',()=>window.__opened++);old.replaceWith(n);return true})()`);
 let before=await ev(`window.__opened`);
 await mouse.dispatchMouseEvent({type:'mousePressed',x:120,y:210,button:'left',clickCount:1});
 await replace('Open agent');
 await mouse.dispatchMouseEvent({type:'mouseReleased',x:120,y:210,button:'left',clickCount:1});
 await waitFor(`window.__opened===${before+1}`,'the redelivered click on the identical control').catch(()=>{});
 assert.equal(await ev(`window.__opened`),before+1,`${width}: an identical control swapped in at the same spot keeps the click: ${JSON.stringify(await ev('window.__pressTrace.slice(-4)'))}`);
 before=await ev(`window.__opened`);
 await mouse.dispatchMouseEvent({type:'mousePressed',x:120,y:210,button:'left',clickCount:1});
 await replace('Delete agent');
 await mouse.dispatchMouseEvent({type:'mouseReleased',x:120,y:210,button:'left',clickCount:1});
 await later(ev);
 assert.equal(await ev(`window.__opened`),before,`${width}: a different control swapped in is never activated`);
 await replace('Open agent');
 await mouse.dispatchMouseEvent({type:'mousePressed',x:120,y:210,button:'left',clickCount:1});
 await replace('Open agent',40);
 await mouse.dispatchMouseEvent({type:'mouseReleased',x:120,y:210,button:'left',clickCount:1});
 await later(ev);
 assert.equal(await ev(`window.__opened`),before,`${width}: the same label swapped in but moved more than 4 px is not activated`);
 await replace('Open agent');
 await ev(`document.getElementById('moving-card-action').focus();true`);
 await mouse.dispatchKeyEvent({type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
 await mouse.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 assert.equal(await ev(`window.__opened`),before+1,'keyboard activation works');
 }
 console.log('PASS Inbox moved-target guard, stable clicks and keyboard');
}finally{await client.close()}})().catch(e=>{console.error(e);process.exitCode=1});
