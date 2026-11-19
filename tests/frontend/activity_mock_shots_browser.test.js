// #19816: the Activity list drawn from the approved mocks' own records (#19813 v1), at 1280 and 390, light and dark. With CORAL_SCREENSHOT_DIR set it saves one picture of each (and the Versions popover and the Q&A preview open); the same file runs on main for the "before" pictures, so it names no new class.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const D = 'a'.repeat(64), D2 = 'b'.repeat(64), V1 = 'c'.repeat(64), V2 = 'd'.repeat(64);
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const failures = [];
 const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
 const min = n => new Date(Date.now() - n * 60000).toISOString();
 const actions = [
  { id: 9, goal_id: 241, goal_title: 'A new user\'s first team', task_id: 19808, task_title: 'Inbox list design mocks', team: 'coral-go-team', at: min(2), action: 'approved', item_kind: 'file', item_id: D, version: D, title: 'inbox-list-design-mocks.html', asker: 'Inbox Designer', note: '', source: 'local' },
  { id: 8, goal_id: 256, goal_title: 'Coral 3.0', task_id: 18583, task_title: 'Compaction message check', team: 'coral-hub', at: min(24), action: 'answer', item_kind: 'question', item_id: '18583', title: 'One quick check for #18583: does a message sent while compacting arrive after compaction finishes?', asker: 'Orchestrator', note: 'Yes: sent right while compacting and it delivered ~2 seconds after compaction finished.', source: 'local' },
  { id: 7, goal_id: 259, goal_title: 'Promo video', task_id: 19787, task_title: 'Promo video cut 1', team: 'coral-go-team', at: min(41), action: 'changes', item_kind: 'file', item_id: V2, version: V2, title: 'promo-cut-1.mp4', asker: 'Video Producer', note: '00:00-00:23: show working agents as green. 01:17: open the Inbox first, then click the document.', source: 'local' },
  { id: 6, goal_id: 259, goal_title: 'Promo video', task_id: 19787, task_title: 'Promo video cut 1', team: 'coral-go-team', at: min(55), action: 'changes', item_kind: 'file', item_id: V1, version: V1, title: 'promo-cut-1.mp4', asker: 'Video Producer', note: 'Second look: better.', source: 'local' },
  { id: 5, team: 'coral-go-team', at: min(60), action: 'goal_close', item_kind: 'goal', item_id: '258', title: 'Team agents have three states (Awake, Asleep, Archived)', note: 'Marked done after v2.1.1 evals passed 3 of 3 runs per case.', source: 'local' },
  { id: 4, goal_id: 256, goal_title: 'Coral 3.0', task_id: 19750, task_title: 'Device keys design', team: 'coral-go-team', at: min(60 * 24 + 30), action: 'approved', item_kind: 'file', item_id: D2, version: D2, title: 'design-19669.md', asker: 'Backend Dev', note: 'Ship draft 7: keep offline fallback read-only until key rotation lands.', source: 'local' },
 ];
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
   await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
   await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
   await ev(`(() => { window.T.state.settings = { ...window.T.state.settings, inbox_welcome:'off' }; document.documentElement.setAttribute('data-theme','${theme}'); const real=window.fetch; window.fetch=(u,o)=>{ const path=new URL(String(u),location.href).pathname; const json=x=>Promise.resolve(new Response(JSON.stringify(x),{status:200,headers:{'content-type':'application/json'}}));
    if(path==='/api/activity') return json({actions:${JSON.stringify(actions)},check:{intact:true,rows:${actions.length}}});
    return real(u,o); }; window.switchNavTab('hub-inbox'); })()`);
   await ev(`import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(m=>m.openInboxGroup('activity'))`);
   await waitFor(`document.querySelectorAll('#group-table-view tbody tr, #group-table-view .al-row').length>=5`, 'the Activity rows', 10000);
   await ev(framesJs(3));
   const at = `${width} ${theme}`;
   try {
    assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth+1`), true, `${at}: no sideways scroll`);
    await shot(`activity-${width}-${theme}`);
    const hasLedger = await ev(`!!document.querySelector('.al-row')`);
    if (hasLedger) {
     assert.equal(await ev(`!!document.querySelector('.al-date-head')`), true, `${at}: date headers`);
     await ev(`document.querySelector('details.al-versions > summary').click(); true`); await ev(framesJs(2));
     assert.equal(await ev(`(()=>{const p=document.querySelector('.al-pop').getBoundingClientRect();return p.left>=0&&p.right<=innerWidth+1})()`), true, `${at}: the Versions popover stays on screen`);
     await shot(`activity-versions-${width}-${theme}`);
     await ev(`document.querySelector('details.al-versions').open=false; document.querySelector('details.al-qa > summary').click(); true`); await ev(framesJs(2));
     await shot(`activity-qa-${width}-${theme}`);
    }
   } catch (e) { failures.push(`${at}: ${e.message}`); }
  }
 } catch (e) { failures.push(e.stack || e.message); }
 try { client.close(); } catch {}
 if (failures.length) { console.error('FAIL activity_mock_shots\n' + failures.join('\n')); process.exit(1); }
 console.log('ok activity_mock_shots');
})();
