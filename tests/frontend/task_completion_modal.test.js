// The completion form on a task's page with a long description (#7644; it was the dialog's): the page scrolls and the pinned bar keeps Complete in view, on a desktop and on a 390 x 520 phone; the required outputs are named
// and the evidence is open; completing without them is refused in words; the manifest and the message complete it with the outcome and the artifacts. Against a stubbed board; the real team page is opened on the task.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT) });
  const { Page, Runtime, Emulation } = client;
  const ev = async expression => {
    const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const { waitFor } = require('./helpers/wait').bind(ev);
  const measure = () => ev(`(()=>{ const f=document.querySelector('#team-panel-item .task-completion-form'), bar=document.querySelector('#team-panel-item .goals-pinbar'), c=[...bar.querySelectorAll('.btn')].find(b=>b.textContent==='Complete'); let s=f; while (s && !(s.scrollHeight > s.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s=s.parentElement; return {scrolls:!!s, completeVisible:!!c && c.getBoundingClientRect().bottom<=innerHeight && c.getBoundingClientRect().top>=0, viewport:innerHeight, required:document.querySelector('.task-completion-required')?.textContent||'', detailsOpen:document.querySelector('.task-completion-evidence')?.open}; })()`);
  const complete = () => ev(`[...document.querySelectorAll('#team-panel-item .goals-pinbar .btn')].find(b=>b.textContent==='Complete').click(); true`);
  try {
    await Page.enable(); await Page.navigate({ url: BASE }); await Page.loadEventFired();
    await ev(`(async()=>{ const S=(window.__coralStatic||'/static/'); const {state}=await import(S+'state.js'); window.testState=state; const task={id:1464,title:'Long completion fixture',body:'${'Long task description '.repeat(120)}',status:'in_progress',priority:'medium',assigned_to:'Frontend Dev',revision:1,workflow:{required_outputs:['build','test_report']},blocked_by:[]}; window.__task=task; window.__completionRequest=null;
      window.fetch=async (url,opts={})=>{ const p=String(url).split('?')[0]; if(opts.method==='POST'&&p.endsWith('/complete')){window.__completionRequest=JSON.parse(opts.body); return new Response('{}',{status:200});} if(/\\/tasks\\/1464$/.test(p)) return new Response(JSON.stringify(task),{status:200,headers:{'Content-Type':'application/json'}}); if(p.endsWith('/tasks')) return new Response(JSON.stringify({tasks:[task]}),{status:200,headers:{'Content-Type':'application/json'}}); return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}); }; })()`);
    await ev(`window.openTeamPage('completion-fixture', { tab: 'tasks', item: 1464 }); true`);
    await waitFor(`!!document.querySelector('#team-panel-item #team-task-title') && [...document.querySelectorAll('#team-panel-item .goals-pinbar .btn')].some(b=>b.textContent==='Complete')`, 'the task page', { timeout: 12000 });
    await complete();
    await waitFor(`!!document.getElementById('task-complete-message')`, 'the completion form');
    const initial = await measure();
    assert.ok(initial.scrolls, JSON.stringify(initial)); assert.equal(initial.completeVisible,true, JSON.stringify(initial)); assert.match(initial.required,/build/); assert.match(initial.required,/test_report/); assert.equal(initial.detailsOpen,true);
    await Emulation.setDeviceMetricsOverride({width:390,height:520,deviceScaleFactor:1,mobile:true});
    await ev(`document.getElementById('task-complete-message').value='verified on mobile'; true`);
    await waitFor(`innerHeight <= 520`, 'the phone viewport');
    const mobile = await measure();
    fs.writeFileSync(require('node:os').tmpdir() + '/coral-1464-completion-mobile.png', Buffer.from((await Page.captureScreenshot()).data, 'base64'));
    assert.ok(mobile.scrolls, JSON.stringify(mobile)); assert.equal(mobile.completeVisible,true, JSON.stringify(mobile));
    await complete();
    await waitFor(`!document.getElementById('task-complete-error').hidden && document.body.textContent.includes('Required outputs missing')`, 'the refusal');
    await ev(`(()=>{ const input=document.getElementById('task-artifacts-file'); const file=new File([JSON.stringify([{name:'build',uri:'coral://artifacts/build'},{name:'test_report',content:'passed'}])],'manifest.json',{type:'application/json'}); Object.defineProperty(input,'files',{value:[file]}); document.getElementById('task-complete-message').value='verified'; })()`);
    await complete();
    await waitFor(`!!window.__completionRequest`, 'the completion request');
    const request = await ev(`window.__completionRequest`);
    assert.equal(request.outcome,'success'); assert.deepEqual(request.artifacts.map(a=>a.name),['build','test_report']);
    console.log(JSON.stringify({initial,mobile,submittedArtifacts:request.artifacts.map(a=>a.name)}));
  } finally { await Emulation.clearDeviceMetricsOverride(); await client.close(); }
})().catch(error => { console.error(error); process.exit(1); });
