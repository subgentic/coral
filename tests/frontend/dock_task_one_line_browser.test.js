// #8792: agent task rows keep status, ellipsized title and avatar on one line.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { openBoardTasksTab } = require('./helpers/board_tasks_tab');
const { removeBoards } = require('./helpers/board_cleanup');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const board = 'task-one-line-' + Date.now().toString(36);
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const failures = [];
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
  await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(()=>true)`);
  const api = (p, body) => ev(`fetch(${JSON.stringify(p)},{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(r=>r.status)`);
  assert.equal(await api(`/api/board/${board}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator' }), 200);
  for (let i = 1; i <= 3; i++) assert.equal(await api(`/api/board/${board}/tasks`, { subscriber_id: 'Boss', assigned_to: 'Boss', title: `Task ${i}: a deliberately long title that must truncate without pushing the status or agent avatar onto another line`, body: 'Details stay in the preview pane.', priority: 'medium' }), 201);
  for (const width of [1280, 390]) { try {
   await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
   await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
   await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(()=>true)`);
   await openBoardTasksTab({ ev, waitFor }, board);
   await waitFor(`document.querySelectorAll('#board-task-list .board-task-item').length>=3`, 'task rows');
   const rows = await ev(`[...document.querySelectorAll('#board-task-list .board-task-item')].map(r=>{const s=r.querySelector('.board-task-status-wrap'),t=r.querySelector('.board-task-name'),a=r.querySelector('.dt-avatar');const rect=e=>{const b=e?.getBoundingClientRect();return b?{x:b.x,y:b.y,w:b.width,h:b.height,mid:b.y+b.height/2}:null;};return {row:rect(r),status:rect(s),title:rect(t),avatar:rect(a),id:!!r.querySelector('.dt-id'),subtitle:!!r.querySelector('.dt-subtitle'),files:!!r.querySelector('[data-key="files"]'),ellipsis:t&&getComputedStyle(t).textOverflow,overflow:document.documentElement.scrollWidth>innerWidth};})`);
   for (const row of rows) {
    assert.ok(row.status && row.title && row.avatar, 'status, title and avatar present: ' + JSON.stringify(row));
    assert.ok(Math.abs(row.status.mid-row.title.mid)<4 && Math.abs(row.avatar.mid-row.title.mid)<4, 'all three share one line: '+JSON.stringify(row));
    assert.ok(row.status.x < row.title.x && row.title.x < row.avatar.x, 'status, title, avatar order');
    assert.ok(!row.id && !row.subtitle && !row.files, 'secondary row metadata removed');
    assert.ok(row.row.h <= 56, 'one-line row height: '+row.row.h);
    if (width === 390) assert.ok(row.title.w >= 44 && row.title.h >= 44, 'title owns the touch target without an ID box');
    assert.equal(row.ellipsis, 'ellipsis'); assert.equal(row.overflow, false);
   }
   const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out'));
   if (dir) { fs.mkdirSync(dir, { recursive: true }); for (const theme of ['light', 'dark']) { await setTheme(ev, theme); fs.writeFileSync(path.join(dir, `dock-task-one-line-${width}-${theme}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
   await ev(`document.querySelector('#board-task-list .board-task-name').click();true`);
   await waitFor(`!!document.querySelector('#preview-pane .team-task-page')`, 'task preview still opens');
  } catch (e) { failures.push(width + ': ' + e.message); console.error(failures.at(-1)); } }
  assert.deepEqual(failures, []);
 } finally { await removeBoards(ev, [board]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
