// #13912/#13923: no overlapping controls; folded desktop Item gets a whole line before time/actions.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {connect}=require('./agent_view_harness');
const BASE=require('./test_base').BASE;
const {coralReady,framesJs}=require('./helpers/wait');
const {removeBoards}=require('./helpers/board_cleanup');
const T='#group-table-view',S=`(window.__coralStatic || '/static/')`;
async function sweep(h,mode){
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=h;
 await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
 await Emulation.setDeviceMetricsOverride({width:740,height:1100,deviceScaleFactor:1,mobile:false});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
        await ev(`fetch('/api/board/qn/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'W' }) }).then(r => r.status)`);
        await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
            const hex = n => n.toString(16).padStart(64, '0');
            const item = (i, name, q) => ({ id: hex(i), name, media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), uploaded_by: 'Writer', produced_by: 'Writer', review_question: q });
            window.__items = [item(1, 'plan-a.md', 'Which port should the test server use?'), item(2, 'plan-b.md', '')];
            window.__asks = [{ board: 'qn', kind: 'ask', id: 7, asker: 'Writer', text: 'May I rename the folder?', at: new Date(Date.now() - 120000).toISOString() }, { board: 'qn', kind: 'ask', id: 8, asker: 'Writer', text: 'Before I rename the folder and move every file in it to the new place, should the old links keep working through a redirect, and who is told about the change when it lands, and may I also delete the empty directories that are left behind afterwards?', at: new Date(Date.now() - 90000).toISOString() }];
            window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'qn': window.__items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                if (u.pathname === '/api/proposals') return json({proposals:[{id:11,board_id:'qn',kind:'task',title:'Update the deployment plan',proposer:'Writer',state:'pending',created_at:new Date().toISOString(),payload:{title:'Update the deployment plan',body:'Check the release instructions before proceeding.'}}]});
                if (u.pathname === '/api/operator-asks') return json(window.__asks);
                if (u.pathname !== '/api/board/qn/artifacts') return original(url, opts);
                return json({ project: 'qn', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false }); }; return true; })()`);
        await ev(`window.__m.add('proj1','Writer',2,{sleeping:false,session_id:'sweep-writer',display_name:'Writer',board_project:'qn'});window._coralSetLiveSessions(Object.values(window.__m.agents).map(a=>window.__m.entry(a)));true`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 5`, 'the review rows and the questions', 20000);

 const results=[];
 for(const font of [16,32]){
  await ev(`document.documentElement.style.fontSize='${font}px';document.documentElement.dataset.theme='${font===16?'light':'dark'}';true`);
  for(let width=320;width<=1280;width+=20){
   await Emulation.setDeviceMetricsOverride({width:mode==='panel'?1600:width,height:1100,deviceScaleFactor:1,mobile:false});
   await ev(`(()=>{const v=document.querySelector('${T}');v.style.width=${JSON.stringify(mode)}==='panel'?'${width}px':'';v.style.maxWidth=${JSON.stringify(mode)}==='panel'?'${width}px':'';v.style.flex=${JSON.stringify(mode)}==='panel'?'0 0 ${width}px':'';})()`);
   await ev(framesJs(4));
   const rows=await ev(`(()=>{let tr;const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height};};const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);if(!(r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&s.clipPath==='none'))return false;for(let p=e.parentElement;p&&p!==tr;p=p.parentElement){const c=getComputedStyle(p),b=p.getBoundingClientRect();if(c.clipPath!=='none'||(/hidden|clip/.test(c.overflow)&& (Math.min(r.right,b.right)-Math.max(r.left,b.left)<2||Math.min(r.bottom,b.bottom)-Math.max(r.top,b.top)<2)))return false;}return true;};const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1;return [...document.querySelectorAll('${T} tbody .dt-row')].map(row=>{tr=row;const i=tr.querySelector('.inbox-kind-icon');if(!i)return null;const icon=rect(i),controls=[...tr.querySelectorAll('button,a,input,label.dt-check-hit')].filter(visible);const collisions=[];for(let a=0;a<controls.length;a++){const c=controls[a];if(overlap(icon,rect(c)))collisions.push('icon/'+(c.getAttribute('aria-label')||c.textContent.trim()||c.className));for(let b=a+1;b<controls.length;b++)if(!c.contains(controls[b])&&!controls[b].contains(c)&&overlap(rect(c),rect(controls[b])))collisions.push('controls/'+c.className+'/'+controls[b].className);}const cell=tr.querySelector('[data-key=agent]'),text=[...tr.querySelectorAll('.inbox-review-from,.inbox-review-name,.inbox-proposal-title')].filter(visible).map(rect);for(const t of text)if(overlap(icon,t))collisions.push('icon/text');const rowBox=rect(tr),contentRight=rowBox.right-parseFloat(getComputedStyle(tr).paddingRight),footer=[tr.querySelector('[data-key=waiting]'),tr.querySelector('.inbox-review-actions')?.closest('td')].filter(e=>e&&visible(e)).map(rect),folded=tr.closest('.dt-box').classList.contains('dt-folded');if(innerWidth>=768&&folded){if(Math.abs(cell.getBoundingClientRect().right-contentRight)>1)collisions.push('folded Item is not full width');if(footer.some(f=>f.y<cell.getBoundingClientRect().bottom-1))collisions.push('time/actions share the Item line');}const phoneGrid=tr.querySelector('.inbox-agent-first');if(innerWidth<=760&&phoneGrid&&!['"from tags wait" "name name name" "more more more"','"from chip star wait" "name name name name" "more more more more"','"from chip star wait" "name name name pill" "more more more more"'].includes(getComputedStyle(phoneGrid).gridTemplateAreas))collisions.push('phone pattern changed');const box=tr.closest('.dt-box'),root=parseFloat(getComputedStyle(document.documentElement).fontSize);if(innerWidth>=768&&box.clientWidth>=40*root&&!box.querySelector('thead th[data-key=agent]').getClientRects().length)collisions.push('desktop headers folded before the 40rem threshold');return{kind:i.dataset.kind,boxWidth:box.clientWidth,itemHeader:box.querySelector('thead th[data-key=agent]').getBoundingClientRect().width,footer,contentRight,folded:tr.closest('.dt-box').classList.contains('dt-folded'),checkbox:!!tr.querySelector('.dt-check input')&&visible(tr.querySelector('.dt-check input')),collisions,icon,cell:rect(cell),text};}).filter(Boolean);})()`);
   assert.ok(['ask','review','proposal'].every(k=>rows.some(r=>r.kind===k)),`${mode}/${width}/${font}: all three row kinds`);
   results.push({mode,width,font,rows});
   const bad=rows.some(r=>r.collisions.length),firstBad=bad&&!results.slice(0,-1).some(x=>x.rows.some(r=>r.collisions.length));
   if(firstBad||[500,740,1280].includes(width)){
    if(process.env.CORAL_SCREENSHOT_DIR&&(firstBad||[500,740,1280].includes(width))){await ev(`document.querySelector('${T} table').scrollIntoView({block:'start'});true`);await ev(framesJs(2));fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.CORAL_SCREENSHOT_DIR,`${mode}-${font}-${width}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}
   }
  }
 }
 return results;
}
(async()=>{
 const main=await connect();let popup,target;const results=[];
 try{
  results.push(...await sweep(main,'dashboard'));
  results.push(...await sweep(main,'panel'));
  target=(await main.client.Target.createTarget({url:'about:blank',newWindow:true})).targetId;
  popup=await connect({target});results.push(...await sweep(popup,'window'));
  // A phone turned sideways is still a phone: the desktop-only footer layout must not reach it.
  await main.Emulation.setDeviceMetricsOverride({width:844,height:390,deviceScaleFactor:1,mobile:true});await main.Emulation.setTouchEmulationEnabled({enabled:true});
  await main.ev(`(()=>{const e=document.querySelector('${T}');e.style.width='';e.style.maxWidth='';e.style.flex='';})()`);await main.ev(framesJs(4));
  assert.equal(await main.ev(`matchMedia('(pointer: coarse)').matches`),true,'landscape phone uses a coarse pointer');
  assert.equal(await main.ev(`getComputedStyle(document.querySelector('${T} .dt-box.dt-folded [data-key=agent]')).flexBasis`),'auto','landscape phone keeps its existing auto Item basis at 200%');
  const bad=results.filter(x=>x.rows.some(r=>r.collisions.length));
  if(process.env.CORAL_SCREENSHOT_DIR)fs.writeFileSync(path.join(process.env.CORAL_SCREENSHOT_DIR,'sweep.json'),JSON.stringify(results,null,2));
  assert.equal(bad.length,0,'No overlaps; full-width folded desktop Item before time/actions; unchanged phone pattern: '+JSON.stringify(bad.map(x=>({mode:x.mode,width:x.width,font:x.font,rows:x.rows.filter(r=>r.collisions.length)})).slice(0,8)));
  console.log('PASS width sweep 320..1280 step20, 100%/200%, dashboard/constrained panel/separate window; ask/review/proposal rows; landscape phone preserved');
 }finally{if(popup){await popup.client.close();await main.client.Target.closeTarget({targetId:target});}await removeBoards(main.ev,['qn']);await main.client.close();}
})().catch(e=>{console.error(e);process.exit(1)});
