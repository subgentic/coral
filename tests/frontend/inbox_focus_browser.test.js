// #20938: real Inbox cards, resting versus pointer/keyboard focus, titles and neutral tiles.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, nextFrame } = require('./helpers/wait');
const { BASE } = require('./test_base');
(async()=>{
 const {client,Page,Emulation,Input,ev,waitFor,PRELOAD,install}=await connect();
 const team='focus-'+Date.now().toString(36),root='#group-table-view .inbox-needs-results',row=root+' tr.inbox-kind-row';
 try{
 await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
 for(const width of [1280,390]){
 await Emulation.setDeviceMetricsOverride({width,height:1600,deviceScaleFactor:1,mobile:width===390});
 await Emulation.setTouchEmulationEnabled({enabled:width===390});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev,'startup','liveList','settings');
 await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'QA Engineer',job_title:'QA'})}).then(r=>r.status)`);
 await ev(`(()=>{const orig=window.fetch,json=b=>Promise.resolve(new Response(JSON.stringify(b),{status:200,headers:{'Content-Type':'application/json'}})),hex=n=>n.toString(16).padStart(64,'0'),ago=n=>new Date(Date.now()-n*3600000).toISOString();const items=[{id:hex(1),name:'report20701.md',media_type:'text/markdown',size:30,created_at:ago(25),source:'upload',available:true,tags:['for review'],produced_by:'QA Engineer',review_question:'Multi-Hub walk: 29 steps pass on a flipped local build, 2 UI findings and 1 labelling question: close #269 or fix first?',goal_id:269,task_id:20701},{id:hex(2),name:'device-pairing-test-guide.md',media_type:'text/markdown',size:30,created_at:ago(26),source:'upload',available:true,tags:['for review'],produced_by:'Lead Developer',review_question:'Pairing guide: try pairing a computer by these steps?'}];window.fetch=(url,opts={})=>{const u=new URL(String(url),location.href),page=u.pathname==='/api/team-artifacts'?window.__reviewFixturePage(u,location.href,{'${team}':items}):null;if(page)return json(page);if(u.pathname==='/api/board/${team}/artifacts')return json({project:'${team}',artifacts:items,has_more:false});if(u.pathname==='/api/goals')return json({goals:[{id:259,board_id:'${team}',title:"Promo video: 'One message to a team'",done_when:'The Operator has the video in their Inbox and says it is good',state:'active',updated_at:ago(16),rollup:{done:1,active:0,blocked:0,queued:0}},{id:279,board_id:'${team}',title:'An agent stopped by a usage limit shows when it resets and resumes on its own at the reset',done_when:'On a mock-agent seed with a Claude, Codex and agy limit, the list shows each reset time and the vendor summary, and which setting on each agent resumes once after its reset (none when the reset is unknown)',state:'active',updated_at:ago(17),rollup:{done:1,active:0,blocked:0,queued:0}}]});return orig(url,opts)};localStorage.removeItem('coral-inbox-needs-filters');window.switchNavTab('hub-inbox');return true})()`);
 await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('needs')).then(()=>true)`);
 await waitFor(`document.querySelectorAll('${row}').length===4`,'two goals and two document cards',15000);
 await ev(`(()=>{const s=document.createElement('style');s.textContent='*,*::before,*::after{transition:none !important}';document.head.append(s);return true})()`);
 const state=()=>ev(`(()=>{const probe=document.createElement('span');probe.style.cssText='color:var(--text-primary);background:var(--bg-tertiary)';document.body.append(probe);const p=getComputedStyle(probe),primary=p.color,tile=p.backgroundColor;probe.style.color='var(--text-secondary)';const secondary=getComputedStyle(probe).color;probe.style.color='var(--success-text,var(--success))';const green=getComputedStyle(probe).color;const rows=[...document.querySelectorAll('${row}')].map(r=>{const b=r.querySelector('.inbox-main-action'),t=(r.querySelector('.inbox-review-name')||r.querySelector('.inbox-v4-heading-text')),i=r.querySelector('.inbox-kind-icon');return {action:b&&getComputedStyle(b).color,title:t&&getComputedStyle(t).color,weight:t&&Number(getComputedStyle(t).fontWeight),tile:i&&getComputedStyle(i).backgroundColor}});probe.remove();return {rows,primary,secondary,tile,green}})()`);
 for(const theme of ['dark','light']){
 await ev(`document.documentElement.setAttribute('data-theme','${theme}');document.activeElement?.blur();true`);
 await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});await nextFrame(ev);
 await ev(`document.getAnimations().forEach(a=>{try{a.finish()}catch{}});true`);
 let s=await state();assert.ok(s.rows.every(r=>r.action===s.secondary),'resting actions neutral '+JSON.stringify(s));
 assert.ok(s.rows.every(r=>r.tile===s.tile),'all kinds have neutral tiles '+JSON.stringify(s));
 assert.ok(s.rows.every(r=>r.title===s.primary&&r.weight>=600),'titles are strongest text '+JSON.stringify(s));
 await ev(`document.querySelector('${row}').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));true`);
 s=await state();assert.equal(s.rows.filter(r=>r.action===s.green).length,1,'one tapped card accent '+JSON.stringify(s));
 await ev(`document.activeElement.blur();true`);
 // A pointer on a different card takes the accent; focus then takes priority over the pointer.
 const point=await ev(`(()=>{const r=document.querySelectorAll('${row}')[1];r.scrollIntoView({block:'center',behavior:'instant'});const b=r.getBoundingClientRect();return {x:b.x+10,y:b.y+10}})()`);
 await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await nextFrame(ev);
 s=await state();assert.equal(s.rows.filter(r=>r.action===s.green).length,1);assert.equal(s.rows[1].action,s.green);
 await ev(`document.querySelectorAll('${row}')[2].querySelector('.inbox-main-action').focus({preventScroll:true});true`);
 s=await state();assert.equal(s.rows.filter(r=>r.action===s.green).length,1,'keyboard focus suppresses other accents');assert.equal(s.rows[2].action,s.green);
 await ev(`document.activeElement.blur();document.activeElement?.blur();true`);
 await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
 await ev(`document.querySelector('${root}').scrollIntoView({block:'start',behavior:'instant'});document.querySelector('${row}').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));document.getAnimations().forEach(a=>{try{a.finish()}catch{}});true`);await nextFrame(ev);
 assert.ok(await ev(`document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`),'no horizontal overflow');
 if(process.env.CORAL_SCREENSHOT_DIR)fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});
 const contrast=await ev(`(()=>{const rows=[...document.querySelectorAll('${row}')];const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');const rgb=colour=>{x.clearRect(0,0,1,1);x.fillStyle=colour;x.fillRect(0,0,1,1);return [...x.getImageData(0,0,1,1).data]};const lum=p=>{const a=p.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return a[0]*.2126+a[1]*.7152+a[2]*.0722};return rows.map(r=>{const t=(r.querySelector('.inbox-review-name')||r.querySelector('.inbox-v4-heading-text')),m=r.querySelector('.inbox-meta'),chain=[];let n=r;while(n){chain.unshift(n);n=n.parentElement}x.fillStyle='white';x.fillRect(0,0,1,1);for(const e of chain){x.fillStyle=getComputedStyle(e).backgroundColor;x.fillRect(0,0,1,1)}const bg=[...x.getImageData(0,0,1,1).data];const ratio=colour=>{const a=lum(rgb(colour)),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)};const title=getComputedStyle(t).color,meta=m&&getComputedStyle(m).color;return {title,meta,background:bg,titleContrast:ratio(title),metaContrast:meta&&ratio(meta)}})})()`);
 assert.ok(contrast.every(r=>r.title!==r.meta&&r.titleContrast>r.metaContrast&&r.metaContrast>=4.5),'title colour leads readable metadata '+JSON.stringify(contrast));
 console.log(JSON.stringify({width,theme,contrast}));
 if(process.env.CORAL_SCREENSHOT_DIR)fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/contrast-'+width+'-'+theme+'.json',JSON.stringify(contrast,null,2));

 if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});const clip=await ev(`(()=>{const r=document.querySelector('${root}').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1}})()`);fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/focus-'+width+'-'+theme+'.png',Buffer.from((await Page.captureScreenshot({format:'png',captureBeyondViewport:true,clip})).data,'base64'));}
 await ev(`document.activeElement?.blur();true`);
 }}
 console.log('PASS quiet Inbox titles/tiles/actions; one current, pointer or keyboard accent; desktop/390 dark/light.');
 }finally{await ev(`fetch('/api/board/${team}',{method:'DELETE'}).then(r=>r.status)`).catch(()=>{});await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
