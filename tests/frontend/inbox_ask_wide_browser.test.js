// #13003: use a flow dialog and a tall question reader on wide screens; retain the
// phone sheet, natural focus order and Escape. Both themes and 200% text.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {connect}=require('./agent_view_harness');
const {coralReady,framesJs}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect(),failures=[];
 const check=(ok,m)=>{if(!ok)failures.push(m);};
 const shot=async n=>{const d=process.env.CORAL_SCREENSHOT_DIR;if(!d)return;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(`${d}/${n}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));};
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1440,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);await ev(`window.switchNavTab('hub-inbox');true`);
   for(const theme of ['dark','light'])for(const font of [16,32])for(const linked of [true,false]){
    await ev(`document.documentElement.setAttribute('data-theme','${theme}');document.documentElement.style.fontSize='${font}px';true`);
    await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'operator_asks.js');window.__askDone=0;await m.openAskDialog({board:'release-team',board_label:'Release team · read markers shared between browsers and phones',asker:'Orchestrator',kind:'ask',id:77,at:new Date().toISOString(),text:'@Operator Why: so read and unread marks match across your browsers and phone.\\n\\n'+('Today each browser keeps its own record. A question read on the laptop can still show as unread on the phone. Store the read marker once, and share it across your devices.\\n\\n').repeat(8)+'Which option should we use?',...(${linked} ? {goal_id:106,goal_title:'The Inbox matches across devices',task_id:9751,task_title:'Read marker proposal'} : {}),buttons:[{id:1,label:'Keep browser-only',action:'reply',state:'pending'},{id:2,label:'Store on Hub',action:'reply',state:'pending'},{id:3,label:'Store on computer',action:'reply',state:'pending'}]},()=>{window.__askDone++;},{goal(){},task(){}});return true;})()`);
    await waitFor(`document.querySelector('.inbox-ask-dialog .ac-add-image')`,'dialog ready');await ev(framesJs(2));
    const p=await ev(`(()=>{const d=document.querySelector('.inbox-ask-dialog'),reader=d.querySelector('.inbox-ask-reading')||d.querySelector('.inbox-ask-text'),box=d.querySelector('textarea'),offers=d.querySelector('.inbox-ask-offers'),r=e=>{const b=e.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height,right:b.right,bottom:b.bottom};};return {dialog:r(d),reader:r(reader),compose:r(d.querySelector('.inbox-ask-compose')),foot:r(d.querySelector('.inbox-ask-foot')),subjects:d.querySelectorAll('.inbox-ask-subjects').length,box:r(box),offers:r(offers),focus:document.activeElement===box,overflow:d.scrollWidth>d.clientWidth+1,hints:d.querySelectorAll('.inbox-ask-offers-hint').length,buttons:[...d.querySelectorAll('.inbox-ask-offer button')].map(r),footer:[...d.querySelectorAll('.inbox-ask-foot button')].map(r)};})()`);
    const at=`${width} ${theme} ${font}px ${linked?"linked":"unlinked"}: `;
    check(p.subjects===(linked?1:0),at+'fixture has expected subject links');check(p.focus,at+'reply keeps initial focus');check(!p.overflow&&p.dialog.x>=-1&&p.dialog.right<=width+1,at+'dialog fits without sideways scroll');
    if(width===1440){check(p.dialog.w>=900,at+'wide dialog width '+p.dialog.w);check(p.reader.h>=280&&p.reader.w>=380,at+'large question reader '+JSON.stringify(p.reader));check(p.box.x>p.reader.x+p.reader.w-1,at+'composer beside question');check(p.hints===1,at+'one visible reply-as-you hint');check(p.footer.every(b=>b.y>=0&&b.bottom<=900),at+'footer available');check(p.foot.y>=Math.max(p.reader.bottom,p.compose.bottom)-1,at+'footer follows reader and composer');check(p.foot.y>=p.dialog.y&&p.foot.bottom<=p.dialog.bottom+1,at+'footer stays inside dialog');}
    else check(p.dialog.w<=390&&p.dialog.h<=900,at+'phone sheet fits');
    await ev(`document.querySelector('.inbox-ask-dialog').scrollTop=0;true`);await shot(`ask-wide-${width}-${theme}-${font}-${linked?"linked":"unlinked"}`);
    // The attachment button belongs to the composer immediately after its textarea.
    await ev(`document.querySelector('.inbox-ask-box').scrollIntoView({block:'center'});true`);await ev(framesJs(2));
    const attach=await ev(`(()=>{const d=document.querySelector('.inbox-ask-dialog'),box=d.querySelector('textarea'),add=d.querySelector('.ac-add-image'),note=d.querySelector('.ac-images-hint'),foot=d.querySelector('.inbox-ask-foot'),rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height};};const focusable=[...d.querySelectorAll('button:not([disabled]),textarea,a[href],input:not([disabled]),select:not([disabled]),[tabindex="0"]')].filter(e=>e.tabIndex>=0&&e.getClientRects().length&&!e.closest('[hidden]'));return {box:rect(box),add:rect(add),note:rect(note),text:note.textContent,near:!!add.closest('.inbox-ask-pics')&&!foot.contains(add),next:focusable[focusable.indexOf(box)+1]===add};})()`);
    check(attach.near&&attach.next,at+'Add image follows the reply in the composer and Tab order');
    check(attach.add.y>=attach.box.bottom-1&&attach.add.y-attach.box.bottom<=24,at+'image button is attached beneath the reply');
    check(attach.note.x>=attach.add.right-1&&attach.note.h>0&&attach.note.bottom>attach.add.y&&attach.note.y<attach.add.bottom,at+'sharing note is visible beside image button');
    check(attach.add.w>=44&&attach.add.h>=44&&/Pictures are shared/.test(attach.text),at+'image target and sharing explanation remain available');
    await shot(`ask-attach-${width}-${theme}-${font}-${linked?'linked':'unlinked'}`);
    // Tab follows the same DOM control order; native dialog wrap may briefly
    // focus BODY or the dialog itself, but never another page control.
    const focus = await ev(`(() => {const d=document.querySelector('.inbox-ask-dialog');window.__askFocusables=[...d.querySelectorAll('button:not([disabled]),textarea,a[href],input:not([disabled]),select:not([disabled]),[tabindex="0"]')].filter(e=>e.tabIndex>=0&&e.getClientRects().length&&!e.closest('[hidden]'));__askFocusables[0].focus();return {count:__askFocusables.length};})()`);
    const tabKey=async()=>{await client.Input.dispatchKeyEvent({type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await client.Input.dispatchKeyEvent({type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});};
    for(let i=1;i<focus.count;i++){
     await tabKey();
     const tab=await ev(`(()=>{const e=__askFocusables[${i}],a=document.activeElement;return {ok:a===e,actual:a?.getAttribute('aria-label')||a?.tagName,expected:e?.getAttribute('aria-label')||e?.tagName};})()`);check(tab.ok,at+'Tab follows unchanged DOM order at '+i+': '+JSON.stringify(tab));
    }
    let wrapped=false;
    for(let step=0;step<3;step++){
     await tabKey();const wrap=await ev(`({first:document.activeElement===__askFocusables[0],native:document.activeElement===document.body||document.activeElement===document.querySelector('.inbox-ask-dialog')})`);
     if(wrap.first){wrapped=true;break;}check(wrap.native,at+'wrap never enters a background control');
    }
    check(wrapped,at+'native dialog wraps to its first control');
    await client.Input.dispatchKeyEvent({type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await client.Input.dispatchKeyEvent({type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await waitFor(`!document.querySelector('.inbox-ask-dialog')`,'Escape closes dialog');check(await ev(`window.__askDone===1`),at+'close callback once');
   }
  }
  assert.deepEqual(failures,[],failures.join('\n'));console.log('PASS inbox_ask_wide_browser');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
