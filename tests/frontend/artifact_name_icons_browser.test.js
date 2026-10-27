// #8978: artifact Names reuse Browse's file icons without adding labels or wrapping rows.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
(async () => {
 const {client, Page, Emulation, ev, PRELOAD, install} = await connect();
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for (const width of [1280,390]) {
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await ev('window.__coralReady.then(()=>true)');
   const rows = await ev(`(async()=>{
    const S=window.__coralStatic||'/static/'; const {artifactTable}=await import(S+'artifact_table.js'); const {fileIconHtml}=await import(S+'file_explorer.js');
    const names=['main.js','README.md','LICENSE','config.yaml','notes.txt','photo.png','a-very-long-artifact-name-that-needs-an-ellipsis-at-phone-width.txt'];
    const host=document.createElement('main');host.style.cssText='position:fixed;inset:0;z-index:1000;background:var(--bg-primary);overflow:auto';document.body.append(host);
    host.append(artifactTable({rows:names.map((name,i)=>({name,id:String(i),size:100,created_at:'2026-10-20T12:00:00Z'})),onOpen:()=>{}}).el);
    return [...host.querySelectorAll('tbody tr')].map(row=>{const cell=row.querySelector('[data-key=name]');const b=cell.querySelector('.dt-primary');const svg=cell.querySelector('svg');const icon=svg?.getBoundingClientRect();const button=b.getBoundingClientRect();return {name:b.textContent,icon:svg?.outerHTML,expected:fileIconHtml(b.textContent),hidden:svg?.getAttribute('aria-hidden'),before:!!icon&&icon.right<=button.left+1,height:row.getBoundingClientRect().height,overflow:host.scrollWidth>innerWidth+1};});
   })()`);
   assert.equal(rows.length,7);
   for(const row of rows){assert.equal(row.icon,row.expected,row.name);assert.equal(row.hidden,'true');assert.equal(row.before,true);assert.ok(row.height<=56);assert.equal(row.overflow,false);}
   const dir=process.env.CORAL_SCREENSHOT_DIR;if(dir){fs.mkdirSync(dir,{recursive:true});for(const theme of ['light','dark']){await setTheme(ev,theme);fs.writeFileSync(path.join(dir,`artifact-icons-${width}-${theme}.png`),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}
  }
 } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
