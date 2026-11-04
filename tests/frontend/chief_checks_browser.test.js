// Local Chief configurator: real lazy UI/forms, mocked API outcomes, no connector execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const FIXTURE = String.raw`(() => {
 const real = window.fetch;
 const target = { session_id:'chief-session',name:'claude-chief-session',display_name:'Chief',board_project:'chief-team',board_label:'Chief desk' };
 const base = { id:1,revision:1,name:'Mail follow-up',instruction:'Check mail for the contract',target_board:'chief-team',target_session:'chief-session',notify_mode:'only_if_found',enabled:true,wake_if_asleep:false,source_key:'user:mail:stdio',schedule_kind:'interval',every_minutes:15,at:'09:00',timezone:'UTC' };
 window.__checks = [base]; window.__runs = []; window.__saved = []; window.__refuse = false; window.__failRun = false;
 window.__triggers = [{id:1,check_id:1,check_name:'Mail follow-up',target_board:'chief-team',state:'open',delivery:'held',delivery_error:'wake_consent_required',reminder:'none',created_at:1700000000,summary:'<img src=x onerror=alert(1)>'}];
 const json = (x,status=200) => Promise.resolve(new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json'}}));
 window.fetch = (url,opts={}) => {
  const u = new URL(String(url),location.href), method = opts.method || 'GET', body = opts.body ? JSON.parse(opts.body) : {};
  if (u.pathname === '/api/chief') return json({enabled:true,session_id:target.session_id,team:target.board_project});
  if (u.pathname === '/api/sessions/live') return json([target]);
  if (u.pathname.endsWith('/mcp-servers')) return json({supported:true,servers:[{name:'mail',scope:'user',transport:'stdio'},{name:'calendar',scope:'project',transport:'stdio'}]});
  if (u.pathname === '/api/chief/checks' && method === 'GET') return json({checks:window.__checks});
  if (u.pathname === '/api/chief/triggers') return json({triggers:window.__triggers});
  if (/\/api\/chief\/checks(?:\/\d+)?$/.test(u.pathname) && ['POST','PUT'].includes(method)) {
   if (window.__refuse) return json({error:'Remove the secret; nothing was saved.'},400);
   const c = {...body,id:body.id || 2,revision:(body.revision || 0)+1}; window.__saved.push(c); window.__checks = [...window.__checks.filter(x=>x.id!==c.id),c]; return json(c);
  }
  if (/\/api\/chief\/checks\/\d+\/run$/.test(u.pathname)) { window.__runs.push({url:u.pathname,key:opts.headers['Idempotency-Key']}); if(window.__failRun && u.pathname.endsWith('/1/run')) return json({error:'Board unavailable'},503); return json({trigger:window.__triggers[0]},202); }
  if (/\/api\/chief\/triggers\/\d+\/state$/.test(u.pathname)) { window.__triggers[0].state = body.state; return json(window.__triggers[0]); }
  return real(url,opts);
 };
 return true;
})()`;
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const click = (selector,text) => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b) throw new Error('Button not found: '+${JSON.stringify(text)}); b.click(); return true; })()`);
 const type = (name,value) => ev(`(() => { const i=document.querySelector('.chief-check-editor [name=${name}]'); i.value=${JSON.stringify(value)}; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for (const [width,mobile,theme,font] of [[1280,false,'dark','100%'],[390,true,'light','100%'],[1280,false,'light','200%'],[390,true,'dark','200%']]) {
   const label = `${width}-${theme}-${font.replace('%','')}`;
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile});
   await Emulation.setTouchEmulationEnabled({enabled:mobile});
   await Page.navigate({url:BASE+'/'}); await Page.loadEventFired(); await install(); await coralReady(ev);
   await ev(FIXTURE);
   await ev(`document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.style.fontSize=${JSON.stringify(font)}; true`);
   await ev(`(async()=>{const m=await import((window.__coralStatic||'/static/')+'chief_checks.js'); await m.showChiefChecks();return true})()`);
   await waitFor(`document.querySelectorAll('.chief-checks-list .chief-check-card').length===1`,'checks loaded');
   assert.equal(await ev(`document.querySelector('.chief-checks-sources').textContent.includes('Coral does not test their connection')`),true,label+' honest source status');
   assert.equal(await ev(`document.querySelector('.chief-checks-recent').textContent.includes('Delivery held')`),true,label+' held is not all clear');
   assert.equal(await ev(`document.querySelectorAll('.chief-check-summary img').length`),0,label+' agent text is not markup');
   assert.equal(await ev(`document.querySelector('.chief-check-summary').textContent`),'<img src=x onerror=alert(1)>');
   assert.equal(await ev(`(()=>{const d=document.querySelector('.chief-checks');return d.scrollWidth<=d.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth+1})()`),true,label+' no horizontal scroll');
   if(process.env.CORAL_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true}); const shot=await Page.captureScreenshot({format:'png'});fs.writeFileSync(path.join(process.env.CORAL_SCREENSHOT_DIR,`chief-checks-${label}.png`),Buffer.from(shot.data,'base64'));}
   await click('.chief-checks-list button','Run now');
   await waitFor(`window.__runs.length===1`,'manual request');
   assert.ok(await ev(`window.__runs[0].key.length>=8`));
   await click('.chief-checks-recent button','Mark done');
   await waitFor(`document.querySelector('.chief-check-state').textContent==='Done'`,'resolved');
   await click('.chief-checks-recent button','Reopen');
   await waitFor(`document.querySelector('.chief-check-state').textContent==='Delivery held'`,'reopened');
   await click('.chief-checks > .chief-check-actions button','New check');
   await waitFor(`!!document.querySelector('.chief-check-editor[open]')`,'editor');
   assert.equal(await ev(`document.querySelector('.chief-check-editor [name=wake_if_asleep]').checked`),false,label+' wake off');
   await type('name','Contract mail'); await type('instruction','Check mail for a signed contract');
   await ev(`window.__refuse=true; document.querySelector('.chief-check-form').requestSubmit();true`);
   await waitFor(`document.querySelector('.chief-check-editor .chief-check-error').textContent.includes('Remove the secret')`,'refusal shown');
   assert.equal(await ev(`document.querySelector('.chief-check-editor [name=instruction]').value`),'Check mail for a signed contract','refusal retains text');
   assert.equal(await ev(`document.querySelector('.chief-check-editor').scrollWidth<=document.querySelector('.chief-check-editor').clientWidth+1`),true,label+' editor reflows');
   await ev(`window.__refuse=false;document.querySelector('.chief-check-form').requestSubmit();true`);
   await waitFor(`!document.querySelector('.chief-check-editor')`,'saved editor closes');
   assert.equal(await ev(`window.__saved.at(-1).target_session`),'chief-session');
   assert.equal(await ev(`window.__saved.at(-1).target_board`),'chief-team');
   assert.equal(await ev(`window.__saved.at(-1).wake_if_asleep`),false);
   if (width===1280 && font==='100%') {
    await click('.chief-checks-list .chief-check-card:first-of-type button','On');
    await waitFor(`window.__checks.find(c=>c.id===1).enabled===false`,'schedule off');
    await ev(`(()=>{const card=[...document.querySelectorAll('.chief-checks-sources .chief-check-card')].find(c=>c.querySelector('h4').textContent==='calendar');card.querySelector('button').click();return true})()`);
    await waitFor(`!!document.querySelector('.chief-check-editor[open]')`,'source check editor');
    await type('instruction','Use calendar to check for meetings needing preparation');
    await type('every_minutes','30');
    await ev(`document.querySelector('.chief-check-form').requestSubmit();true`);
    await waitFor(`!document.querySelector('.chief-check-editor')`,'source saved');
    assert.equal(await ev(`window.__saved.at(-1).source_key`),'project:calendar:stdio');
    assert.equal(await ev(`window.__saved.at(-1).every_minutes`),30);
    await ev(`window.__failRun=true;true`);
    await click('.chief-checks-head button','Run all checks now');
    await waitFor(`document.querySelector('.chief-checks > [role=status]').textContent.includes('1 could not be scheduled')`,'partial failure retained');
    assert.equal(await ev(`window.__runs.length`),3,'all checks attempted despite first failure');
    assert.equal(await ev(`new Set(window.__runs.slice(-2).map(r=>r.key)).size`),2,'each check has its own action key');
   }
   await click('.chief-checks-head button','Close');
   await waitFor(`!document.querySelector('.chief-checks')`,'dialog closes');
  }
  console.log('PASS Chief checks desktop/phone, both themes, 200% text, refused saves, exact targets, run and resolve/reopen');
 } finally {await client.close();}
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
