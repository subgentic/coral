// #13811: the approved full-width phone search; native filtering remains real, Hub frames own theirs.
const assert=require('node:assert/strict');const fs=require('node:fs');
const {connect}=require('./agent_view_harness');const {coralReady}=require('./helpers/wait');
const {setupHubWorld,BASE}=require('./helpers/hub_world');
(async()=>{const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();
const shot=async n=>{if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/'+n+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}};
const select=key=>ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab(${JSON.stringify(key)})).then(()=>true)`);
try{await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
for(const [width,height,mobile] of [[390,844,true],[430,932,true],[844,390,true]]){
 await Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor:1,mobile});await Emulation.setTouchEmulationEnabled({enabled:mobile});await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
 for(const theme of ['light','dark']){await ev(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});true`);await select('needs');await waitFor(`!!document.querySelector('#inbox-needs-search')&&!!document.querySelector('#top-phone-bar .phone-bar-search')`,'native search');
 const box=await ev(`(()=>{const b=document.querySelector('#top-phone-bar'),i=b.querySelector('input'),m=b.querySelector('.phone-menu-btn').getBoundingClientRect(),a=b.querySelector('.phone-account-btn').getBoundingClientRect(),r=i.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,height:r.height,controlsBottom:Math.max(m.bottom,a.bottom),menu:m.height,account:a.height,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
 assert.ok(Math.abs(box.left)<=1&&Math.abs(box.right-width)<=1&&box.top>=box.controlsBottom&&box.height>=44&&!box.overflow,`${width} ${theme}: full-width field beneath shell controls `+JSON.stringify(box));
 assert.ok(box.menu>=44&&box.account>=44);if(width===390)await shot('native-search-'+theme+'-390');
 const query='search-'+width+'-'+theme;await ev(`window.__searchInput=[];document.querySelector('#inbox-needs-search').addEventListener('input',e=>window.__searchInput.push(e.target.value));document.querySelector('#top-phone-bar input').focus();document.querySelector('#top-phone-bar input').select();true`);await client.Input.insertText({text:query});await waitFor(`document.querySelector('#inbox-needs-search').value===${JSON.stringify(query)}&&window.__searchInput.includes(${JSON.stringify(query)})`,'real native search receives typing').catch(async e=>{console.error(await ev(`JSON.stringify({active:document.activeElement?.outerHTML,from:document.querySelector('#top-phone-bar input')?.value,to:document.querySelector('#inbox-needs-search')?.value,seen:window.__searchInput})`));throw e;});
 await ev(`document.querySelector('#top-phone-bar input').value='';document.querySelector('#top-phone-bar input').dispatchEvent(new Event('input',{bubbles:true}));window.switchNavTab('automations');true`);await waitFor(`!!document.querySelector('#top-phone-bar input')&&/Automations/.test(document.querySelector('#top-phone-bar input').placeholder)`,'other view');
 assert.equal(await ev(`document.querySelector('#top-phone-bar').classList.contains('phone-inbox-bar')`),false,'other views keep their own bar');
 }
}
await Emulation.setDeviceMetricsOverride({width:1280,height:900,deviceScaleFactor:1,mobile:false});await Emulation.setTouchEmulationEnabled({enabled:false});await select('needs');assert.equal(await ev(`document.querySelector('#top-phone-bar').getClientRects().length`),0,'desktop keeps its existing header');
await setupHubWorld({client,Page,Emulation,width:390,height:844,mobile:true,inbox:'native',hubPages:true});await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await coralReady(ev,'startup','settings');
for(const folder of ['needs','tasks','saved']){await select(folder);await waitFor(`document.querySelector('#group-table-view iframe')?.contentDocument?.URL.endsWith('/inbox/hub/${folder}')&&document.querySelector('#group-table-view iframe')?.contentDocument?.readyState==='complete'&&!!document.querySelector('#group-table-view iframe')?.contentDocument?.body`,'Hub frame');
 // Fixture for the Hub-owned search contract confirmed by coral-hub through the Orchestrator.
 await ev(`(()=>{const d=document.querySelector('#group-table-view iframe').contentDocument;const i=d.createElement('input');i.type='search';i.placeholder='Search inbox';i.setAttribute('aria-label','Search inbox');i.style.cssText='display:block;box-sizing:border-box;width:100%;height:52px';d.body.prepend(i);return true;})()`);
 assert.equal(await ev(`document.querySelectorAll('#top-phone-bar input').length`),0,'no duplicate shell search for framed '+folder);
 assert.equal(await ev(`document.querySelector('#group-table-view iframe').contentDocument.querySelectorAll('input[type=search]').length`),1,'exactly one frame-owned search for '+folder);
 if(folder==='needs')await shot('framed-search-390');}
console.log('PASS full-width phone Inbox search, native input forwarding, other views/desktop and one Hub-frame-owned search');
}finally{await client.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
