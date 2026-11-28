// #21838: with Group by Task ticked a team's Orchestrator is the team's first row, right under its heading and above On a task / No task, and it is in neither group (whatever its task state; its task line stays).
// Team and Task: per team. Task alone: the orchestrators head the list, above the split. Two teams: alpha's Orchestrator is on a task, beta's has none. Isolated dev server, the harness's stand-in agents.
const strict = require('node:assert/strict');
const shotsOnly = !!process.env.CORAL_SHOTS_ONLY; // the before shots: take them on the old code, where the assertions below fail
const assert = shotsOnly ? new Proxy(strict, { get: (t, k) => (k === 'match' || k === 'equal' || k === 'ok' ? () => {} : t[k]) }) : strict;
const fs = require('node:fs');
const { framesJs } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const shots = process.env.CORAL_SCREENSHOT_DIR;
 const task = (id, title) => ({ id, title, status: 'in_progress' });
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
  for (const [width, mobile, listId, barId] of [[1280, false, 'live-sessions-list', 'agent-list-bar'], [390, true, 'mobile-agent-list', 'mobile-agent-list-bar']]) {
   await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile });
   await Emulation.setTouchEmulationEnabled({ enabled: mobile, maxTouchPoints: 5 });
   await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
   await ev(`localStorage.clear(); localStorage.removeItem('coral-agent-grouping'); true`);
   await ev(`(() => {
    T.state.hub = false; T.state.liveSessions = []; window.__m.agents = {};
    window.__tasks = { 'Orchestrator': ${JSON.stringify(task(21838, 'Group by Task: Orchestrator on top'))}, 'Frontend Dev': ${JSON.stringify(task(21685, 'Sidebar: Group by Task'))}, 'Docs Writer': ${JSON.stringify(task(21701, 'Release notes'))} };
    const base = window.__m.entry.__base || window.__m.entry, answer = a => ({ ...base.call(window.__m, a), board_task: window.__tasks[a.name] || null }); answer.__base = base; window.__m.entry = answer;
    const add = (name, team, extra = {}) => window.__m.add(name, 'P', 3, { sleeping: false, board_project: team, display_name: name, ...extra });
    add('Orchestrator', 'alpha'); add('Frontend Dev', 'alpha'); add('Backend Dev', 'alpha');
    window.__m.add('Lead Orchestrator', 'P', 3, { sleeping: false, board_project: 'beta', display_name: 'Orchestrator' }); add('Docs Writer', 'beta'); add('Hub Lead', 'beta');
    T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
   const root = `#${listId}`;
   const shot = async name => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await ev(`(() => { const b = [...document.querySelectorAll('[data-display-button]')].find(x => x.getClientRects().length); if (b && b.getAttribute('aria-expanded') === 'true') b.click(); return true; })()`); await ev(framesJs(6)); /* the Display panel is closed for the shot: the list is the picture */ fs.writeFileSync(`${shots}/${name}-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } };
   const tick = k => ev(`(() => { const b = [...document.querySelectorAll('[data-display-button]')].find(x => x.getClientRects().length); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); document.querySelector('#${barId} fieldset[data-group-by] input[data-box="${k}"]').click(); return true; })()`);
   await waitFor(`document.querySelectorAll('${root} .session-group-item, ${root} .status-more').length >= 1`, 'the agents are listed');
   // Team and Task are ticked by default (#22104): the list opens split.
   await waitFor(`document.querySelectorAll('${root} .session-team-group .status-sub').length >= 2`, 'each team splits by task');
   // Each team: its first row is the Orchestrator, no split group holds it, and its task line (alpha's) stays.
   const teams = await ev(`[...document.querySelectorAll('${root} .session-team-group')].map(g => { const rows = [...g.querySelectorAll(':scope > li, li')].filter(l => l.matches('.session-group-item, .status-sub')); const first = rows.find(l => l.matches('.session-group-item')); const inSplit = [...g.querySelectorAll('li[data-in]')].map(l => l.textContent); return { firstIsOrch: !!first && /Orchestrator/.test(first.textContent), beforeSplit: rows.indexOf(first) < rows.findIndex(l => l.matches('.status-sub')), inSplit: inSplit.filter(t => /Orchestrator/.test(t)).length, orchRows: [...g.querySelectorAll('.session-group-item')].filter(l => /Orchestrator/.test(l.textContent)).length, line: first ? (first.querySelector('.session-task-line') || {}).textContent || '' : '' }; })`);
   assert.equal(teams.length, 2, `${width}: two teams`);
   for (const t of teams) { assert.ok(t.firstIsOrch, `${width}: the Orchestrator is the team's first row ${JSON.stringify(t)}`); assert.ok(t.beforeSplit, `${width}: above the split`); assert.equal(t.inSplit, 0, `${width}: in neither split group`); assert.equal(t.orchRows, 1, `${width}: drawn once`); }
   assert.match(teams.find(t => t.line).line, /#21838/, `${width}: the Orchestrator on a task keeps its task line`);
   assert.equal(teams.filter(t => t.line).length, 1, `${width}: the one without a task has no line`);
   await shot('orchestrator-team-task');
   // Task alone: the orchestrators head the list, above On a task, in neither group.
   await tick('team');
   await waitFor(`document.querySelectorAll('${root} .session-team-group').length === 0 && document.querySelectorAll('${root} .status-sub').length >= 1`, 'Task alone');
   const flat = await ev(`(() => { const ls = [...document.querySelectorAll('${root} li')]; const sub = ls.findIndex(l => l.matches('.status-sub')); const orch = ls.map((l, i) => l.matches('.session-group-item') && /Orchestrator/.test(l.textContent) ? i : -1).filter(i => i >= 0); return { sub, orch, inSplit: ls.filter(l => l.hasAttribute('data-in') && /Orchestrator/.test(l.textContent)).length }; })()`);
   assert.equal(flat.orch.length, 2, `${width}: both Orchestrators are drawn ${JSON.stringify(flat)}`);
   assert.ok(flat.orch.every(i => i < flat.sub), `${width}: both above On a task ${JSON.stringify(flat)}`); assert.equal(flat.inSplit, 0, `${width}: in neither group`);
   await shot('orchestrator-task-only');
  }
  console.log('group_by_orchestrator_browser: ok');
 } finally { try { client.close(); } catch {} }
})().catch(e => { console.error(e); process.exit(1); });
