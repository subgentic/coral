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
  { id: 10, goal_id: 241, goal_title: 'A new user\'s first team', task_id: 19808, task_title: 'Inbox list design mocks', team: 'coral-go-team', at: min(1), action: 'approve', item_kind: 'file', item_id: 'e'.repeat(64), version: 'e'.repeat(64), title: 'login-screen.png', asker: 'Inbox Designer', note: 'Looks right.', file_n: 1, file_latest_n: 1, ask: 'Is this the login screen you wanted?', source: 'hub' },
  { id: 9, goal_id: 241, goal_title: 'A new user\'s first team', task_id: 19808, task_title: 'Inbox list design mocks', team: 'coral-go-team', at: min(2), action: 'approve', item_kind: 'file', item_id: D, version: D, title: 'inbox-list-design-mocks.html', asker: 'Inbox Designer', note: '', file_n: 1, file_latest_n: 1, ask: 'Please review the Inbox list mocks.', source: 'local' },
  { id: 13, goal_id: 241, goal_title: 'A new user\'s first team', task_id: 19808, task_title: 'Inbox list design mocks', team: 'coral-go-team', at: min(5), action: 'prompt_allow', item_kind: 'agent', item_id: 'claude-bob', title: '', note: 'Yes, and don\'t ask again for npm commands', command: 'npm install --save-dev vitest <b>not bold</b>', source: 'local' },
  { id: 12, team: 'coral-go-team', at: min(6), action: 'prompt_reject', item_kind: 'agent', item_id: 'claude-bob', title: '', note: 'No', source: 'local' },
  { id: 11, goal_id: 259, goal_title: 'Promo video', task_id: 19787, task_title: 'Promo video cut 1', team: 'coral-go-team', at: min(7), action: 'dismiss', item_kind: 'file', item_id: 'f'.repeat(64), version: 'f'.repeat(64), title: 'sale-banner-ideas.html', asker: 'Video Producer', note: '', file_n: 1, file_latest_n: 1, source: 'local' },
  { id: 8, goal_id: 256, goal_title: 'Coral 3.0', task_id: 18583, task_title: 'Compaction message check', team: 'coral-hub', at: min(24), action: 'answer', item_kind: 'question', item_id: '18583', title: 'One quick check for #18583: does a message sent while compacting arrive after compaction finishes?', asker: 'Orchestrator', note: 'Yes: sent right while compacting and it delivered ~2 seconds after compaction finished.', source: 'local' },
  { id: 7, goal_id: 259, goal_title: 'Promo video', task_id: 19787, task_title: 'Promo video cut 1', team: 'coral-go-team', at: min(41), action: 'changes', item_kind: 'file', item_id: V2, version: V2, title: 'promo-cut-1.mp4', asker: 'Video Producer', note: '00:00-00:23: show working agents as green. 01:17: open the Inbox first, then click the document.', file_n: 2, file_latest_n: 2, ask: 'Cut 1 of the promo video, ready for review.', file_versions: [{ digest: V1, n: 1, at: min(60*3) }, { digest: V2, n: 2, at: min(45) }], source: 'local' },
  { id: 6, goal_id: 259, goal_title: 'Promo video', task_id: 19787, task_title: 'Promo video cut 1', team: 'coral-go-team', at: min(55), action: 'changes', item_kind: 'file', item_id: V1, version: V1, title: 'promo-cut-1.mp4', asker: 'Video Producer', note: 'Second look: better.', file_n: 1, file_latest_n: 2, ask: 'Cut 1 of the promo video, ready for review.', file_versions: [{ digest: V1, n: 1, at: min(60*3) }, { digest: V2, n: 2, at: min(45) }], source: 'local' },
  { id: 5, team: 'coral-go-team', at: min(60), action: 'goal_close', item_kind: 'goal', item_id: '258', title: 'Team agents have three states (Awake, Asleep, Archived)', note: 'Marked done after v2.1.1 evals passed 3 of 3 runs per case.', source: 'local' },
  { id: 4, goal_id: 256, goal_title: 'Coral 3.0', task_id: 19750, task_title: 'Device keys design', team: 'coral-go-team', at: min(60 * 24 + 30), action: 'approve', item_kind: 'file', item_id: D2, version: D2, title: 'design-19669.md', asker: 'Backend Dev', note: 'Ship draft 7: keep offline fallback read-only until key rotation lands.', file_n: 7, file_latest_n: 7, ask: 'Approve draft 7 of the device keys design?', source: 'local' },
 ];
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
   await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
   await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
   await ev(`(() => { window.T.state.settings = { ...window.T.state.settings, inbox_welcome:'off' }; document.documentElement.setAttribute('data-theme','${theme}'); const real=window.fetch; window.fetch=(u,o)=>{ const path=new URL(String(u),location.href).pathname; const json=x=>Promise.resolve(new Response(JSON.stringify(x),{status:200,headers:{'content-type':'application/json'}}));
    if(path.endsWith('/thumbnail')) return new Promise(res=>{const c=document.createElement('canvas');c.width=c.height=64;const g=c.getContext('2d');g.fillStyle='#2f6fed';g.fillRect(0,0,64,64);g.fillStyle='#ffd166';g.fillRect(8,36,48,20);g.beginPath();g.arc(44,20,8,0,7);g.fill();c.toBlob(b=>res(new Response(b,{status:200,headers:{'content-type':'image/png'}})));});
    if(path==='/api/activity') return json({actions:window.__empty?[]:${JSON.stringify(actions)},check:window.__broken?{intact:false,rows:${actions.length},first_bad:4,reason:'edited'}:{intact:true,rows:${actions.length}}});
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
     assert.equal(await ev(`!!document.querySelector('.al-date-head')`), true, `${at}: date headings`);
     const gap = await ev(`(()=>{const bar=document.querySelector('.inbox-folder-toolbar'), h=document.querySelector('.al-sum'); return {headTop:Math.round(h.getBoundingClientRect().top), barBottom:Math.round(bar.getBoundingClientRect().bottom)}})()`);
     assert.ok(gap.headTop - gap.barBottom <= 24, `${at}: no empty band between the toolbar and the count line: ${JSON.stringify(gap)}`);
     assert.ok(await ev(`/^\\d+ actions?$/.test(document.querySelector('.al-sum').textContent)`), `${at}: the line under the top row says how many actions the list has`);
     assert.ok(await ev(`[...document.querySelectorAll('.al-date-head')].every(h => /^\\d+$/.test(h.querySelector('.al-day-count')?.textContent || ''))`), `${at}: every day heading has its count`);
     assert.ok(await ev(`!!document.querySelector('.al-switch') && !!document.querySelector('.al-kind-menu') && !document.querySelector('.team-tb-pills')?.getClientRects().length`), `${at}: a two-part switch and a Kind menu, not seven tabs`);
     assert.ok(await ev(`[...document.querySelectorAll('.al-row')].every(r => { const s = r.querySelector('.al-lead svg'); return s && Math.round(s.getBoundingClientRect().width) === 16; })`), `${at}: every row wears a 16 px kind mark`);
     assert.equal(await ev(`document.querySelectorAll('.al-open, .al-chip, .al-vchip, .al-vnewer, .al-tile, .al-qa').length`), 0, `${at}: no heavy buttons, pills, tiles or previews on a row`);
     assert.ok(await ev(`[...document.querySelectorAll('.al-ver')].some(e => /^version 1 of 2$/.test(e.textContent))`), `${at}: "version 1 of 2" in grey, once`);
     assert.ok(await ev(`!document.querySelector('.al-ask') && !!document.querySelector('.al-title[title]')`), `${at}: no ask line under a file name (the mock draws none); the ask is the name's tip`);
     assert.ok(await ev(`!!document.querySelector('.al-sub .al-glink svg.al-gflag') && !!document.querySelector('.al-sub .al-v-ok') && !!document.querySelector('.al-sub .al-v-ch')`), `${at}: the goal has its flag; the verdict words are green and amber`);
     assert.ok(await ev(`[...document.querySelectorAll('.al-ynote')].some(e => /^Your note:/.test(e.textContent))`), `${at}: your note on a change request is a plain box`);
     assert.deepEqual(await ev(`[...document.querySelectorAll('.al-row')].filter(r => /(asked for permission|wanted to run a command)$/.test(r.querySelector('.al-title').textContent)).map(r => r.querySelector('.al-title').textContent + ' | ' + r.querySelector('.al-v').textContent + ' | ' + !!r.querySelector('.al-cmd'))`), ['claude-bob wanted to run a command | ✓ Allowed | true', 'claude-bob asked for permission | ✕ Denied | false'], `${at}: a permission names the agent, says Allowed or Denied (as Needs you); the command shows in its box only when the record kept one`);
     assert.deepEqual(await ev(`(() => { const c = document.querySelector('.al-cmd'); return [c.textContent, c.children.length, getComputedStyle(c).whiteSpace, c.scrollWidth <= c.clientWidth + 1]; })()`), ['npm install --save-dev vitest <b>not bold</b>', 0, 'pre-wrap', true], `${at}: the command is text only (a tag shows as characters), wrapped whole and inside its box`);
     assert.ok(await ev(`[...document.querySelectorAll('.al-sub')].some(e => e.textContent.includes("(Yes, and don't ask again for npm commands)")) && ![...document.querySelectorAll('.al-sub')].some(e => /\\(No\\)/.test(e.textContent))`), `${at}: the option label shows only when it says more than yes or no`);
     assert.ok(await ev(`!!document.querySelector('.al-sub .al-v-dm') && [...document.querySelectorAll('.al-sub .al-v-dm')].some(e => e.textContent === 'Dismissed')`), `${at}: a dismissed file reads Dismissed in grey`);
     assert.ok(await ev(`(()=>{const w=document.querySelector('.al-sub .al-who'); return !!w && w.textContent === 'Orchestrator' && +getComputedStyle(w).fontWeight >= 600})()`), `${at}: the agent an answer went to is a bold link`);
     assert.equal(await ev(`getComputedStyle(document.querySelector('.al-sub')).display`), 'block', `${at}: the second line wraps as one run of words, not one item per line`);
     assert.ok(await ev(`document.querySelector('.al-sub')?.textContent.includes('via Coral Hub') || [...document.querySelectorAll('.al-sub')].some(e => e.textContent.includes('via Coral Hub'))`), `${at}: a decision made through Coral Hub says so`);
     const rowBox = await ev(`(()=>{const r=[...document.querySelectorAll('.al-row')].find(x => x.querySelector('details.al-versions')); r.scrollIntoView({block:'center'}); const b=r.getBoundingClientRect(); return {x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2)}})()`);
     if (width >= 600) {
      assert.equal(await ev(`getComputedStyle(document.querySelector('.al-hov')).display`), 'none', `${at}: no button shows until you point at a row`);
      await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: rowBox.x, y: rowBox.y }); await ev(framesJs(3));
      assert.ok(await ev(`(()=>{const r=document.querySelector('.al-row:hover'); return !!r && getComputedStyle(r.querySelector('.al-hov')).display !== 'none' && getComputedStyle(r.querySelector('.al-when')).display === 'none'})()`), `${at}: pointing at a row shows its buttons in place of the time`);
      await shot(`activity-hover-${width}-${theme}`);
      await ev(`document.querySelector('.al-row:hover details.al-more > summary').click(); true`); await ev(framesJs(2));
      assert.ok(await ev(`document.querySelectorAll('details.al-more[open] .al-menu-item').length>=1`), `${at}: the More menu opens with its actions`);
      await shot(`activity-more-${width}-${theme}`);
      await ev(`document.querySelectorAll('details.al-more').forEach(d => d.open = false); true`);
      await ev(`document.querySelector('.al-row:hover details.al-versions > summary').click(); true`); await ev(framesJs(2));
      assert.equal(await ev(`(()=>{const p=document.querySelector('details.al-versions[open] .al-pop').getBoundingClientRect();return p.left>=0&&p.right<=innerWidth+1})()`), true, `${at}: the Versions popover stays on screen`);
      await shot(`activity-versions-${width}-${theme}`);
      await ev(`document.querySelectorAll('details.al-versions').forEach(d => d.open = false); true`);
      await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 });
     } else {
      assert.ok(await ev(`(()=>{const r=[...document.querySelectorAll('.al-row')].find(x => x.querySelector('.al-dots')); const d=r.querySelector('details.al-dots > summary'); return getComputedStyle(r.querySelector('.al-hov')).display === 'none' && d && Math.round(d.getBoundingClientRect().height) >= 44 && Math.round(d.getBoundingClientRect().width) >= 44})()`), `${at}: a phone has one 44 px menu, not the buttons`);
      await ev(`(()=>{const r=[...document.querySelectorAll('.al-row')].find(x => x.querySelector('details.al-versions')); r.scrollIntoView({block:'center'}); r.querySelector('details.al-dots > summary').click(); return true})()`); await ev(framesJs(2)); // the row in view: the mock's phone menu is open on a file with versions
      assert.ok(await ev(`(()=>{const p=document.querySelector('details.al-dots[open] .al-pop').getBoundingClientRect(); return p.left>=0 && p.right<=innerWidth+1 && document.querySelectorAll('details.al-dots[open] .al-menu-item').length>=1})()`), `${at}: the phone menu opens on screen with its actions`);
      assert.ok(await ev(`(()=>{const d=document.querySelector('details.al-dots[open]'), p=d.querySelector('.al-pop').getBoundingClientRect(), s=d.querySelector('summary').getBoundingClientRect(), b=d.querySelector('.al-menu-item'); return p.width < innerWidth * 0.75 && Math.abs(p.right - s.right) <= 24 && getComputedStyle(b).textAlign === 'left' && p.top >= s.bottom - 1})()`), `${at}: the phone menu is a narrow list hung from the dots at the right, words at the left (the mock)`);
      await shot(`activity-more-${width}-${theme}`);
      await ev(`document.querySelectorAll('details.al-dots').forEach(d => d.open = false); true`);
     }
     await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`); await ev(framesJs(2));
     await shot(`activity-filters-${width}-${theme}`);
     assert.equal(await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .al-preset')].map(b => b.textContent).join('|')`), 'Today|Last 7 days|Last 30 days', `${at}: the Since field has its quick dates`);
     await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`); await ev(framesJs(2));
     await ev(`[...document.querySelectorAll('.al-row[data-kind="file"] button.al-title')].find(b => /promo-cut-1/.test(b.textContent)).click(); true`); await ev(framesJs(3));
     assert.ok(await ev(`!!document.querySelector('.activity-file-dialog .activity-file-series')`), `${at}: the file dialog lists the file's versions`);
     await shot(`activity-file-${width}-${theme}`);
     await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector('.activity-file-dialog')?.closest('dialog, .modal, .coral-dialog')?.remove(); true`);
     await ev(`window.__broken = true; import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(async m => { await m.openInboxGroup('saved'); await m.openInboxGroup('activity'); })`); await ev(framesJs(6));
     assert.equal(await ev(`(()=>{const t=document.querySelector('.activity-check-broken .activity-check-title'), d=document.querySelector('.activity-check-broken .activity-check-detail'); return !t || d.getBoundingClientRect().top >= t.getBoundingClientRect().bottom - 1})()`), true, `${at}: the notice's sentence sits under its title`);
     if (await ev(`!!document.querySelector('.activity-check-broken')`)) assert.equal(await ev(`document.querySelector('.activity-check-broken .activity-check-detail').textContent`), 'The record was changed outside Coral: a row was edited. Earlier entries remain readable.', `${at}: the warning says the mock's words, once`);
     if (await ev(`!!document.querySelector('.activity-check-broken')`)) { const f = await ev(`(() => { const d = document.querySelector('.activity-check-broken .activity-check-detail'), t = document.querySelector('.activity-check-broken .activity-check-title'), c = getComputedStyle(d), h = getComputedStyle(t); return { body: parseFloat(c.fontSize), lh: Math.round(parseFloat(c.lineHeight) / parseFloat(c.fontSize) * 100) / 100, title: parseFloat(h.fontSize) }; })()`); // #19935 (QA2 on #19924): the mock's notice is 13 px with a 12.5 px sentence at line height 1.45
       assert.ok(Math.abs(f.body - 12.5) < 0.05 && Math.abs(f.lh - 1.45) < 0.02 && f.title === 13, `${at}: the warning's text is the mock's size and line height: ` + JSON.stringify(f)); }
     if (await ev(`!!document.querySelector('.activity-check-broken')`)) { await shot(`activity-integrity-${width}-${theme}`); }
     await ev(`window.__broken = false; window.__empty = true; import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(async m => { await m.openInboxGroup('saved'); await m.openInboxGroup('activity'); })`); await ev(framesJs(6));
     if (await ev(`!!document.querySelector('#group-table-view .empty-state')`)) await shot(`activity-empty-${width}-${theme}`);
    }
   } catch (e) { failures.push(`${at}: ${e.message}`); }
  }
 } catch (e) { failures.push(e.stack || e.message); }
 try { client.close(); } catch {}
 if (failures.length) { console.error('FAIL activity_mock_shots\n' + failures.join('\n')); process.exit(1); }
 console.log('ok activity_mock_shots');
})();
