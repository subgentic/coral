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
  { id: 10, goal_id: 241, goal_title: 'A new user\'s first team', task_id: 19808, task_title: 'Inbox list design mocks', team: 'coral-go-team', at: min(1), action: 'approved', item_kind: 'file', item_id: 'e'.repeat(64), version: 'e'.repeat(64), title: 'login-screen.png', asker: 'Inbox Designer', note: 'Looks right.', file_n: 1, file_latest_n: 1, ask: 'Is this the login screen you wanted?', source: 'hub' },
  { id: 9, goal_id: 241, goal_title: 'A new user\'s first team', task_id: 19808, task_title: 'Inbox list design mocks', team: 'coral-go-team', at: min(2), action: 'approved', item_kind: 'file', item_id: D, version: D, title: 'inbox-list-design-mocks.html', asker: 'Inbox Designer', note: '', file_n: 1, file_latest_n: 1, ask: 'Please review the Inbox list mocks.', source: 'local' },
  { id: 8, goal_id: 256, goal_title: 'Coral 3.0', task_id: 18583, task_title: 'Compaction message check', team: 'coral-hub', at: min(24), action: 'answer', item_kind: 'question', item_id: '18583', title: 'One quick check for #18583: does a message sent while compacting arrive after compaction finishes?', asker: 'Orchestrator', note: 'Yes: sent right while compacting and it delivered ~2 seconds after compaction finished.', source: 'local' },
  { id: 7, goal_id: 259, goal_title: 'Promo video', task_id: 19787, task_title: 'Promo video cut 1', team: 'coral-go-team', at: min(41), action: 'changes', item_kind: 'file', item_id: V2, version: V2, title: 'promo-cut-1.mp4', asker: 'Video Producer', note: '00:00-00:23: show working agents as green. 01:17: open the Inbox first, then click the document.', file_n: 2, file_latest_n: 2, ask: 'Cut 1 of the promo video, ready for review.', file_versions: [{ digest: V1, n: 1, at: min(60*3) }, { digest: V2, n: 2, at: min(45) }], source: 'local' },
  { id: 6, goal_id: 259, goal_title: 'Promo video', task_id: 19787, task_title: 'Promo video cut 1', team: 'coral-go-team', at: min(55), action: 'changes', item_kind: 'file', item_id: V1, version: V1, title: 'promo-cut-1.mp4', asker: 'Video Producer', note: 'Second look: better.', file_n: 1, file_latest_n: 2, ask: 'Cut 1 of the promo video, ready for review.', file_versions: [{ digest: V1, n: 1, at: min(60*3) }, { digest: V2, n: 2, at: min(45) }], source: 'local' },
  { id: 5, team: 'coral-go-team', at: min(60), action: 'goal_close', item_kind: 'goal', item_id: '258', title: 'Team agents have three states (Awake, Asleep, Archived)', note: 'Marked done after v2.1.1 evals passed 3 of 3 runs per case.', source: 'local' },
  { id: 4, goal_id: 256, goal_title: 'Coral 3.0', task_id: 19750, task_title: 'Device keys design', team: 'coral-go-team', at: min(60 * 24 + 30), action: 'approved', item_kind: 'file', item_id: D2, version: D2, title: 'design-19669.md', asker: 'Backend Dev', note: 'Ship draft 7: keep offline fallback read-only until key rotation lands.', file_n: 7, file_latest_n: 7, ask: 'Approve draft 7 of the device keys design?', source: 'local' },
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
     assert.equal(await ev(`!!document.querySelector('.al-date-head')`), true, `${at}: date headers`);
     const gap = await ev(`(()=>{const bar=document.querySelector('.inbox-folder-toolbar'), h=document.querySelector('.al-date-head'); return {headTop:Math.round(h.getBoundingClientRect().top), barBottom:Math.round(bar.getBoundingClientRect().bottom)}})()`);
     assert.ok(gap.headTop - gap.barBottom <= 24, `${at}: no empty band between the toolbar and the first date header: ${JSON.stringify(gap)}`);
     assert.ok(await ev(`[...document.querySelectorAll('.al-date-head')].every(h => /^\\d+$/.test(h.querySelector('.al-day-count')?.textContent || ''))`), `${at}: every date header has its day count`);
     assert.equal(await ev(`(()=>{const p=document.querySelector('.inbox-folder-toolbar .team-tb-pills-multi'), r=p.getBoundingClientRect(), bar=document.querySelector('.inbox-folder-toolbar').getBoundingClientRect(); return r.width>150&&getComputedStyle(p).display!=='none'&&r.left>=bar.left-1&&[...p.querySelectorAll('.goals-chip')].length===7&&getComputedStyle(document.querySelector('.inbox-folder-toolbar .inbox-pill-field')).display==='none'})()`), true, `${at}: MUST-12 the seven kind pills are inline in the toolbar, not check boxes in Filters`);
     assert.ok(await ev(`[...document.querySelectorAll('.al-chip')].every(c => c.getBoundingClientRect().width < 160)`), `${at}: chips hold short labels`);
     assert.equal(await ev(`document.querySelectorAll('.al-tile.al-fk-video, .al-tile.al-fk-markdown, .al-tile.al-fk-html').length>=3`), true, `${at}: video, markdown and html tiles are tinted by kind`);
     assert.ok(await ev(`!!document.querySelector('.al-vnewer') && /v1 reviewed/.test(document.querySelector('.al-vnewer').textContent)`), `${at}: v1 reviewed · v2 newer`);
     assert.ok(await ev(`!!document.querySelector('.al-ask')`), `${at}: the asked question shows under a file name`);
     await waitFor(`!!document.querySelector('.al-tile-thumb img')`, `${at}: the picture's thumbnail is drawn in its tile`, 8000);
     assert.ok(await ev(`document.querySelector('.al-via')?.textContent === 'via Coral Hub'`), `${at}: a decision made through Coral Hub says so`);
     assert.ok(await ev(`[...document.querySelectorAll('.al-ans-label')].map(e=>e.textContent).includes('Approved with note:') && [...document.querySelectorAll('.al-ans-label')].map(e=>e.textContent).includes('Changes requested:')`), `${at}: the callouts say what the words are`);
     await ev(`document.querySelector('.al-row[data-kind="goal"] details.al-more > summary').click(); true`); await ev(framesJs(2));
     assert.ok(await ev(`[...document.querySelectorAll('.al-row[data-kind="goal"] .al-menu-item')].some(b => b.textContent === 'Reopen goal')`), `${at}: a closed goal's More has Reopen goal`);
     await ev(`document.querySelector('.al-row[data-kind="goal"] details.al-more').open=false; true`);
     await ev(`document.querySelector('details.al-more > summary').click(); true`); await ev(framesJs(2));
     assert.ok(await ev(`document.querySelectorAll('details.al-more[open] .al-menu-item').length>=2`), `${at}: the More menu opens with its actions`);
     assert.equal(await ev(`(()=>{const p=document.querySelector('details.al-more[open] .al-pop').getBoundingClientRect(); return [...document.querySelectorAll('details.al-more[open] .al-menu-item')].every(i => i.getBoundingClientRect().right <= p.right - 1) || JSON.stringify([p.right, [...document.querySelectorAll('details.al-more[open] .al-menu-item')].map(i => [i.textContent, i.getBoundingClientRect().right, i.scrollWidth, i.clientWidth])])})()`), true, `${at}: MUST-10 every More item sits inside its menu's border`);
     await shot(`activity-more-${width}-${theme}`);
     await ev(`document.querySelector('details.al-more').open=false; true`);
     if (width < 600) assert.equal(await ev(`(()=>{const r=document.querySelector('.al-row[data-kind="file"]'), m=r.querySelector('.al-main').getBoundingClientRect().left, b=r.querySelector('.al-actions .btn').getBoundingClientRect().left; return Math.abs(b-m)<2||b-m})()`), true, `${at}: MUST-11 the action buttons start at the text's left edge`);
     await ev(`document.querySelector('details.al-versions > summary').click(); true`); await ev(framesJs(2));
     assert.equal(await ev(`(()=>{const p=document.querySelector('details.al-versions[open] .al-pop').getBoundingClientRect();return p.left>=0&&p.right<=innerWidth+1})()`), true, `${at}: the Versions popover stays on screen`);
     assert.equal(await ev(`(()=>{const p=document.querySelector('details.al-versions[open] .al-pop'); return ([...p.querySelectorAll('.al-pop-state')].every(e => e.getBoundingClientRect().width > 40) && p.getBoundingClientRect().height < 160) || JSON.stringify([p.getBoundingClientRect().width, p.getBoundingClientRect().height, [...p.querySelectorAll('.al-pop-state')].map(e => [e.getBoundingClientRect().width, e.textContent])])})()`), true, `${at}: MUST-9 the version rows read as words, the popover is short (not one character a line)`);
     if (width < 600) assert.ok(await ev(`document.querySelector('details.al-versions[open] .al-pop').getBoundingClientRect().width > 300`), `${at}: MUST-9 a phone's popover is as wide as the row`);
     await shot(`activity-versions-${width}-${theme}`);
     await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`); await ev(framesJs(2));
     await shot(`activity-filters-${width}-${theme}`);
     assert.equal(await ev(`[...document.querySelectorAll('.inbox-folder-toolbar .al-preset')].map(b => b.textContent).join('|')`), 'Today|Last 7 days|Last 30 days', `${at}: MUST-12 the Since field has its quick dates`);
     assert.equal(await ev(`(()=>{const m=document.querySelector('.inbox-folder-toolbar .list-bar-menu'), r=m.getBoundingClientRect(); const scrolls = /auto|scroll/.test(getComputedStyle(m).overflowY); /* a phone's sheet scrolls inside itself: its controls are reached by scrolling */ const bad = [...m.querySelectorAll('select, input, .al-preset')].filter(e => e.getClientRects().length && e.getBoundingClientRect().width > 4 && ((!scrolls && e.getBoundingClientRect().bottom > r.bottom + 1) || e.getBoundingClientRect().right > r.right + 1)).map(e => (e.id || e.className) + ':' + Math.round(e.getBoundingClientRect().right) + '/' + Math.round(r.right) + ',' + Math.round(e.getBoundingClientRect().bottom) + '/' + Math.round(r.bottom)); return (!bad.length && (scrolls || m.scrollHeight <= m.clientHeight + 1)) || JSON.stringify(bad)})()`), true, `${at}: MUST-11 every Filters control sits inside the panel (Action, Since, Sort, Group by are reachable)`);
     await ev(`document.querySelector('.inbox-folder-toolbar .list-bar-toggle').click(); true`); await ev(framesJs(2));
     await ev(`document.querySelector('details.al-versions').open=false; document.querySelector('details.al-qa > summary').click(); true`); await ev(framesJs(2));
     assert.ok(await ev(`document.querySelectorAll('details.al-qa[open] .al-qa-msg').length>=2`), `${at}: the Q&A preview shows its messages`);
     await shot(`activity-qa-${width}-${theme}`);
     await ev(`document.querySelector('details.al-qa').open=false; [...document.querySelectorAll('.al-row[data-kind="file"] button.al-title')].find(b => /promo-cut-1/.test(b.textContent)).click(); true`); await ev(framesJs(3));
     assert.ok(await ev(`!!document.querySelector('.activity-file-dialog .activity-file-series')`), `${at}: the file dialog lists the file's versions`);
     await shot(`activity-file-${width}-${theme}`);
     await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector('.activity-file-dialog')?.closest('dialog, .modal, .coral-dialog')?.remove(); true`);
     await ev(`window.__broken = true; import((window.__coralStatic||'/static/')+'inbox_sidebar.js').then(async m => { await m.openInboxGroup('saved'); await m.openInboxGroup('activity'); })`); await ev(framesJs(6));
     assert.equal(await ev(`(()=>{const t=document.querySelector('.activity-check-broken .activity-check-title'), d=document.querySelector('.activity-check-broken .activity-check-detail'); return !t || d.getBoundingClientRect().top >= t.getBoundingClientRect().bottom - 1})()`), true, `${at}: the notice's sentence sits under its title`);
     if (await ev(`!!document.querySelector('.activity-check-broken')`)) assert.equal(await ev(`document.querySelector('.activity-check-broken .activity-check-detail').textContent`), 'The record was changed outside Coral: a row was edited. Earlier entries remain readable.', `${at}: the warning says the mock's words, once`);
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
