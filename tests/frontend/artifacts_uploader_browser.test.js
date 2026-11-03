// #12996: latest-version uploader attribution on desktop and the phone's second line.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {connect}=require('./agent_view_harness');
const {coralReady,framesJs}=require('./helpers/wait');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor,PRELOAD,install}=await connect();const failures=[];
 const check=(ok,msg)=>{if(!ok)failures.push(msg);};
 const shot=async name=>{const d=process.env.CORAL_SCREENSHOT_DIR;if(!d)return;fs.mkdirSync(d,{recursive:true});fs.writeFileSync(`${d}/${name}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));};
 try{
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:844,deviceScaleFactor:1,mobile:width===390});await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   await ev(`(()=>{const real=window.fetch,json=b=>Promise.resolve(new Response(JSON.stringify(b),{headers:{'content-type':'application/json'}}));window.__artifactRequests=[];
    const fields=[{name:'Agent role.txt',uploader:'Ada',role:'Release Engineering Lead',version:2,versions:2},{name:'Agent name.txt',uploader:'Zed'},{name:'Operator upload.txt',uploaded_by:'owner',owner_kind:'operator'},{name:'Old record.txt',owner_kind:'operator'}];
    window.__artifactRows=fields.map((f,i)=>({...f,id:String(i+1).repeat(64),board_id:'team-a',team:'Release team',media_type:'text/plain',size:42,created_at:'2026-11-03T00:00:00Z',available:true,source:'upload',uri:'coral://artifacts/'+String(i+1).repeat(64)}));
    window.fetch=(url,o={})=>{const u=new URL(String(url),location.origin);if(u.pathname==='/api/team-artifacts'){window.__artifactRequests.push(u.searchParams.get('sort'));return json({artifacts:window.__artifactRows,all:4,total:4,has_more:false,teams:[{board_id:'team-a',team:'Release team',all:4}]});}return real(url,o);};return true;})()`);
   await ev(`window.switchNavTab('hub-inbox');import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('artifacts')).then(()=>true)`);
   await waitFor(`document.querySelectorAll('#group-table-view .artifact-table tbody tr.dt-row').length===4`,'four attribution cases');
   for(const theme of ['dark','light']){
    await ev(`document.documentElement.setAttribute('data-theme','${theme}');true`);await ev(framesJs(2));
    const p=await ev(`(()=>{const box=document.querySelector('#group-table-view .artifact-table'),h=box.querySelector('th[data-key="uploader"]');return {header:h?.textContent.trim(),headerShown:!!h&&h.getClientRects().length>0,rows:[...box.querySelectorAll('tbody tr.dt-row')].map(r=>{const cell=r.querySelector('td[data-key="uploader"]'),line=r.querySelector('.dt-mail-ask'),node=${width}===390?line:cell;if(${width}===1280)cell?.firstElementChild?.dispatchEvent(new PointerEvent('pointerenter'));return {cut:!!cell&&cell.scrollWidth>cell.clientWidth,text:r.textContent,name:r.querySelector('.dt-mail-title')?.textContent||r.querySelector('td[data-key="name"]')?.textContent,by:node?.textContent.trim(),title:cell?.querySelector('[title]')?.title,chip:!!node?.querySelector('.dt-tag')||!!node?.classList.contains('dt-tag'),line:line?.getBoundingClientRect().top,titleBottom:r.querySelector('.dt-mail-title')?.getBoundingClientRect().bottom};}),overflow:document.documentElement.scrollWidth>innerWidth+1};})()`);
    const at=`${width} ${theme}: `;
    check(width===390?!p.headerShown:p.header?.startsWith('Uploaded by'),at+'desktop Uploaded by column / phone has no new column');
    for(const [name,label,chip] of [['Agent role.txt','Release Engineering Lead',false],['Agent name.txt','Zed',false],['Operator upload.txt','Operator',true],['Old record.txt','—',false]]){
     const r=p.rows.find(r=>r.name?.includes(name));check(r?.by===label,at+name+' attribution '+JSON.stringify(r));check(!!r?.chip===chip,at+name+' Operator is distinguished by shared tag');
     if(width===1280)check(!r?.cut||r?.title===label,at+name+' full title while cut');
     else check(r?.line>=r?.titleBottom-1,at+name+' uploader is on second line');
    }
    check(!p.overflow,at+'no horizontal overflow');await shot(`uploader-${width}-${theme}`);
   }
   if(width===1280&&await ev(`!!document.querySelector('th[data-key="uploader"] .dt-sort')`)){
    await ev(`document.querySelector('th[data-key="uploader"] .dt-sort').click();true`);await ev(framesJs(2));
    let order=await ev(`[...document.querySelectorAll('.artifact-table tbody tr.dt-row')].map(r=>r.querySelector('td[data-key="uploader"]').textContent.trim())`);
    check(order.indexOf('Operator')<order.indexOf('Release Engineering Lead')&&order.indexOf('Release Engineering Lead')<order.indexOf('Zed'),'uploader header sorts ascending: '+JSON.stringify(order));
    await ev(`document.querySelector('th[data-key="uploader"] .dt-sort').click();true`);await ev(framesJs(2));
    order=await ev(`[...document.querySelectorAll('.artifact-table tbody tr.dt-row')].map(r=>r.querySelector('td[data-key="uploader"]').textContent.trim())`);
    check(order.indexOf('Zed')<order.indexOf('Release Engineering Lead')&&order.indexOf('Release Engineering Lead')<order.indexOf('Operator'),'uploader header sorts descending: '+JSON.stringify(order));
   }
  }
  assert.deepEqual(failures,[],failures.join('\n'));console.log('PASS artifacts_uploader_browser');
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exit(1);});
