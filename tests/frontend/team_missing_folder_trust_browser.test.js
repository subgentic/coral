// #16673: folders the launch creates explain automatic trust; existing paths keep consent.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
 const {client, Page, Emulation, ev, waitFor, PRELOAD, install} = await connect();
 const failures = [];
 const inspect = () => ev(`(() => { const t=document.getElementById('launch-team-trust'), l=document.getElementById('launch-team-trust-line'); return { toggle: !t.closest('.sv-row').hidden, line: !l.closest('.sv-row').hidden, text: l.textContent, warning: t.closest('.sv-row').textContent }; })()`);
 const shot = async name => {if(!process.env.CORAL_SCREENSHOT_DIR)return;fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true});fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR+'/'+name+'.png',Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));};
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]) {
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await coralReady(ev);
   await ev(`(() => {const real=window.fetch;const json=(b,s=200)=>Promise.resolve(new Response(JSON.stringify(b),{status:s,headers:{'Content-Type':'application/json'}}));window.fetch=(u,o={})=>{const p=new URL(String(u),location.origin);if(p.pathname==='/api/filesystem/list'){const d=p.searchParams.get('path');return ['/work','/work/existing'].includes(d)?json({entries:d==='/work'?['existing']:[]}):json({error:'not found'},404);}if(p.pathname==='/api/filesystem/trust-probe')return json({checked:false});if(p.pathname==='/api/board/projects')return json([]);return real(u,o);};return true;})()`);
   await ev(`(async()=>{await window.showLaunchModal();window._selectLaunchType('team');return true;})()`);
   await waitFor(`document.getElementById('launch-step-team').dataset.stage==='team'`,'team folder step');
   const setDir = async (dir,suggested) => {
    await ev(`(() => { const d=document.getElementById('launch-team-dir'); d.value=${JSON.stringify(dir)}; ${suggested?'d.dataset.suggested=d.value;':'delete d.dataset.suggested;'} d.dispatchEvent(new Event('input',{bubbles:true}));d.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    // Next calls the same check immediately, avoiding dependence on the input debounce.
    await ev(`import((window.__coralStatic||'/static/')+'team_dialogs.js').then(m=>m.teamStepMove(1))`);
    await ev(framesJs(4));
   };
   await ev(`(() => {const n=document.getElementById('team-board-name');n.value='folder-check';n.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
   await setDir('/home/test/Coral/folder-check',true);
   let v=await inspect();
   if(v.toggle||!v.line||v.text!=='Coral creates this folder and trusts it for the team') failures.push(`${width}: suggested missing folder: ${JSON.stringify(v)}`);
   await ev(`import((window.__coralStatic||'/static/')+'team_dialogs.js').then(m=>m.teamStepMove(-1))`);
   await setDir('/work/new-team',false);
   v=await inspect();
   if(v.toggle||!v.line||v.text!=='Coral creates this folder and trusts it for the team') failures.push(`${width}: typed new folder: ${JSON.stringify(v)}`);
   await ev(`import((window.__coralStatic||'/static/')+'team_dialogs.js').then(m=>m.teamStepMove(-1))`);
   await ev(`document.getElementById('launch-team-dir').scrollIntoView({block:'center'});true`);await shot(`team-new-folder-${width}`);
   await setDir('/work/existing',false); v=await inspect();
   if(!v.toggle||v.line||!v.warning.includes('Coral will not trust /work/existing unless this is on')) failures.push(`${width}: existing folder: ${JSON.stringify(v)}`);
  }
  assert.deepEqual(failures,[]);console.log('PASS missing suggested/typed folders explain trust; edited existing folder keeps consent');
 } finally {await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
