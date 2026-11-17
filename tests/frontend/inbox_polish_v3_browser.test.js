// #17453: current cards, grey kind icons, whole commands and matching folder navigation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const command = 'coral-board task show 123 --format json';
const question = '@Operator Please inspect this command. ' + 'Context to keep the preview bounded. '.repeat(18) + '\n```sh\n' + command + '\n```\nThe final line stays visible.';
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const failures = [];
 const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
  for (const width of [1440, 1280, 390]) {
   await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
   await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
   await ev(`(() => { window.T.state.settings = { ...window.T.state.settings, inbox_welcome:'off' }; const real=window.fetch; window.fetch=(u,o)=>{ const path=new URL(String(u),location.href).pathname; const json=x=>Promise.resolve(new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}}));
    if(path==='/api/operator-asks') return json([{board:'garden',board_label:'Garden',kind:'ask',id:51,asker:'Designer',text:${JSON.stringify(question)},at:new Date(Date.now()-60000).toISOString()}]);
    if(path==='/api/activity') return json({actions:[{id:5,actor:'hub-user-private-id',source:'hub',action:'answer',item_kind:'question',item_id:'51',title:'Which layout should we use?',asker:'Designer',note:'Option two',team:'garden',at:new Date().toISOString()}],check:{intact:true,rows:1}});
    return real(u,o); }; window.switchNavTab('hub-inbox'); })()`);
   await ev(`import((window.__coralStatic||'/static/')+'operator_asks.js').then(m=>m.refreshOperatorAsks(true))`);
   await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('needs'))`);
   await waitFor(`!!document.querySelector('.inbox-ask-expand')`, 'question preview', 10000);
   await ev(`document.querySelector('.inbox-ask-expand').click(); true`); await ev(framesJs(3));
   await shot(`needs-${width}`);
   await ev(`window.__kindColor=getComputedStyle(document.querySelector('.inbox-kind-icon')).color;true`);
   try {
    assert.equal(await ev(`document.querySelector('.inbox-ask-name code')?.textContent`),command+'\n',`${width}: expanded command remains a whole code block`);
    await ev(`window.__copied=''; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text;}}}); document.querySelector('.inbox-command button').click();true`);
    await waitFor(`window.__copied===${JSON.stringify(command+'\n')}`, 'Copy preserves exact command', 3000);
    assert.ok(await ev(`document.querySelector('.inbox-ask-name').textContent.includes('The final line stays visible.')`));
   } catch (e) { failures.push(e.message); }
   if (width === 390) {
    const parity = await ev(`(async()=>{const {state}=await import((window.__coralStatic||'/static/')+'state.js');const rows=state.inboxFolderRows().sections;const d=await import((window.__coralStatic||'/static/')+'phone_drawer.js');const nodes=d.drawerTop();return {want:rows.flatMap(s=>s.items.map(i=>[i.label,i.count==null?(i.unread&&i.total!=null?String(i.total):''):String(i.count)])),got:nodes.filter(n=>n.matches?.('button.nav-drawer-folder')).map(n=>[n.querySelector('.nav-drawer-label').textContent,n.querySelector('.nav-drawer-count')?.textContent||''])};})()`);
    try { assert.deepEqual(parity.got,parity.want,'phone drawer uses the sidebar rows and exact counts'); } catch(e) { failures.push(e.message); }
    const countCases = await ev(`(async()=>{const {state}=await import((window.__coralStatic||'/static/')+'state.js');const old=state.inboxFolderRows;try {state.inboxFolderRows=()=>({current:'chats',pick:()=>{},sections:[{title:'Inbox',items:[{key:'chats',label:'All chats',unread:true,total:120},{key:'tasks',label:'Tasks',count:0},{key:'needs',label:'Needs you',count:'120+'}]}]});const d=await import((window.__coralStatic||'/static/')+'phone_drawer.js');return d.drawerTop().filter(n=>n.matches?.('button.nav-drawer-folder')).map(n=>n.querySelector('.nav-drawer-count')?.textContent||'');} finally {state.inboxFolderRows=old;}})()`);
    try { assert.deepEqual(countCases,['120','0','120+'],'chat totals, known zero and partial counts match the sidebar'); } catch(e) { failures.push(e.message); }

   }
   try { assert.equal(await ev(`import((window.__coralStatic||'/static/')+'operator_asks.js').then(m=>m.askIsLong({text:${JSON.stringify('Run this:\n```sh\ncoral status\n```')}}))`),true,'a short fenced command can expand too'); } catch(e) { failures.push(e.message); }
   const folders=await ev(`import((window.__coralStatic||'/static/')+'mailbox_chats.js').then(m=>m.chatSections({all:0,group:0,notes:0,starred:0,active:0,archived:0,by_agent_type:{claude:1,codex:0,opencode:0,hermes:0},tags:[]}).flatMap(s=>s.items.map(i=>i.key)))`);
   try { assert.deepEqual(folders,['chats'],`${width}: empty folders hidden and By CLI waits for second CLI`); } catch(e) { failures.push(e.message); }
   await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('activity'))`);
   await waitFor(`!!document.querySelector('.activity-card')`, 'Activity card', 10000); await ev(framesJs(3)); await shot(`activity-${width}`);
   try {
    const icon=await ev(`(()=>{const n=document.querySelector('.activity-who .inbox-kind-icon');return n&&{kind:n.dataset.kind,color:getComputedStyle(n).color,width:n.getBoundingClientRect().width,glyph:getComputedStyle(n,'::before').content};})()`);
    assert.ok(icon,`${width}: Activity reuses kind icon`); assert.equal(icon.kind,'question'); assert.equal(icon.color,await ev(`window.__kindColor`),'same grey kind icon on both pages'); assert.ok(icon.glyph.includes('help_outline')); assert.equal(icon.width,width===390?40:32);
    assert.equal(await ev(`!!document.querySelector('.activity-check')`),false,'healthy record check remains hidden');
    assert.equal(await ev(`document.querySelector('.activity-folder').textContent.includes('hub-user-private-id')`),false,'no actor id');
   } catch(e) { failures.push(e.message); }
  }
 } finally { await client.close(); }
 assert.deepEqual(failures,[]); console.log('PASS #17453 expanded commands, shared icons and quiet folders at 1440/1280/390');
})().catch(e=>{console.error(e);process.exit(1);});
