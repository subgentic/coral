// #8960: Goals, Needs you and team Agents stay on one line at 1280 and 390.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, agentsUp, openTeam, goTab } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const TEAM = 'one-line-' + Date.now().toString(36);
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const { settle } = require('./helpers/wait').bind(ev);
 const check = async selector => {
  await waitFor(`document.querySelectorAll('${selector} tbody .dt-row').length>0`, 'rows');
  const result = await ev(`(() => {const table=document.querySelector('${selector} .dt-table');return {folded:table.closest('.dt-box').classList.contains('dt-folded'),subtitles:table.querySelectorAll('.dt-subtitle').length,rows:[...table.querySelectorAll('tbody .dt-row')].map(r=>({height:r.getBoundingClientRect().height,ys:[...r.cells].filter(c=>c.getClientRects().length).map(c=>c.getBoundingClientRect().y)})),overflow:document.documentElement.scrollWidth>innerWidth+1};})()`);
  assert.equal(result.folded,false);assert.equal(result.subtitles,0);assert.equal(result.overflow,false);
  for(const row of result.rows){assert.ok(row.height<=56,JSON.stringify(row));assert.ok(row.ys.every(y=>Math.abs(y-row.ys[0])<2));}
 };
 const shot = async name => {const dir=process.env.CORAL_SCREENSHOT_DIR||(process.env.RUNNER_TEMP&&path.join(process.env.RUNNER_TEMP,'out'));if(dir){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name+'.png'),Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}};
 try {
  await Page.enable();await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  for(const width of [1280,390]){
   await Emulation.setDeviceMetricsOverride({width,height:900,deviceScaleFactor:1,mobile:width===390});await Emulation.setTouchEmulationEnabled({enabled:width===390});
   await Page.navigate({url:BASE+'/'});await Page.loadEventFired();await install();await ev('window.__coralReady.then(()=>true)');await installTP(ev);await seed(ev,TEAM);await agentsUp(ev);
   await openTeam(ev,waitFor,TEAM);await goTab(ev,settle,'Goals');await check('#team-panel-goals');await shot('one-line-team-goals-'+width);
   await goTab(ev,settle,'Agents');await check('#team-panel-agents');
   assert.deepEqual(await ev(`[...document.querySelectorAll('#team-panel-agents th[data-key]')].map(h=>h.dataset.key)`),['agent','status','doing','remind']);await shot('one-line-agents-'+width);
   await ev(`window.switchNavTab('hub-inbox');true`);await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m=>m.selectInboxTab('goals')).then(()=>true)`);await check('#group-table-view');await shot('one-line-inbox-goals-'+width);
   await ev(`(async()=>{window.__qaState.liveSessions=window.__qaState.liveSessions.map(s=>({...s,waiting_for_input:true,waiting_kind:'permission',waiting_summary:'Wants to run: an intentionally long command that must stay on one line without losing its full request'}));const m=await import((window.__coralStatic||'/static/')+'inbox_tab.js');m.updateInboxTab();m.selectInboxTab('needs');return true;})()`);
   await waitFor(`document.querySelector('#group-table-view td[data-key=asks]')?.textContent.includes('Wants to run')`,'request column');await check('#group-table-view');
   assert.equal(await ev(`getComputedStyle(document.querySelector('#group-table-view td[data-key=asks]')).textOverflow`),'ellipsis');await shot('one-line-needs-'+width);
  }
 } finally {await removeBoards(ev,[TEAM]);await client.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
