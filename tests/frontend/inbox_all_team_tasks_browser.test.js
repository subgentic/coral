// #16799: shared sidebar order and all-team tasks; before/after at desktop/phone in both themes.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {connect}=require('./agent_view_harness'),{setTheme}=require('./helpers/contrast');
const BASE=require('./test_base').BASE;
(async()=>{
 const {client,Page,Emulation,ev,waitFor}=await connect();const {coralReady}=require('./helpers/wait').bind(ev);const {framesJs}=require('./helpers/wait');const errors=[];
 const rows=[{id:1,board_id:'team-a',board_label:'Team A',title:'Owner task',assigned_to:'Operator',status:'pending'},{id:2,board_id:'team-b',board_label:'Team B',title:'Builder task',assigned_to:'Builder',status:'in_progress'},{id:3,board_id:'team-b',board_label:'Team B',title:'Finished task',assigned_to:'Reviewer',status:'completed'}].map(t=>({...t,priority:'medium',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),revision:1}));
 try{
 await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:`(()=>{const real=window.fetch;window.fetch=(u,o)=>{const url=new URL(String(u),location.origin);if(url.pathname==='/api/board/tasks'&&(!o||!o.method||o.method==='GET')){const a=url.searchParams.get('assigned_to'),st=url.searchParams.getAll('status');return Promise.resolve(Response.json({tasks:${JSON.stringify(rows)}.filter(t=>(!a||t.assigned_to===a)&&(!st.length||st.includes(t.status)))}));}return real(u,o);};})()`});
 for(const width of [1440,390]){
 await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});await Emulation.setTouchEmulationEnabled({enabled:width===390});
 await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await coralReady();
 await ev(`window.switchNavTab('hub-inbox');true`);await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('tasks'))`);
 await waitFor(`document.querySelector('#group-table-view')?.textContent.includes('Owner task')`,'task list');
 const sections=await ev(`import((window.__coralStatic||'/static/')+'state.js').then(({state})=>state.inboxFolderRows().sections.flatMap(s=>s.items).slice(0,6).map(i=>({key:i.key,label:i.label,count:i.count})))`);
 if(JSON.stringify(sections.map(i=>i.key))!==JSON.stringify(['needs','saved','activity','goals','tasks','artifacts']))errors.push(width+': order '+JSON.stringify(sections));
 if(sections.find(i=>i.key==='saved')?.label!=='Saved for later')errors.push(width+': saved label');
 const text=await ev(`document.querySelector('#group-table-view').textContent`);if(!text.includes('Builder task')||!text.includes('Finished task'))errors.push(width+': all assignments and done tasks missing');
 const mine=await ev(`(()=>{const b=[...document.querySelectorAll('#group-table-view button')].find(b=>b.textContent.includes('Assigned to me'));if(b)b.click();return !!b;})()`);
 if(!mine)errors.push(width+': missing Assigned to me chip');else{await waitFor(`!document.querySelector('#group-table-view').textContent.includes('Builder task')`,'mine filter');await ev(`[...document.querySelectorAll('#group-table-view button')].find(b=>/^All(?:\\s|\\d|$)/.test(b.textContent.trim()))?.click();true`);}
 for(const theme of ['dark','light']){await setTheme(ev,theme);await ev(framesJs(2));if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/inbox-tasks-'+width+'-'+theme+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}
 }
 assert.deepEqual(errors,[]);
 }finally{await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
