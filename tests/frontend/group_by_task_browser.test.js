// #21685: Group by is three check boxes in the agent list's Display panel (Computer, Team, Task), all unticked until chosen, nesting computer, then team, then task. Task splits a scope into
// On a task / No task from the live row's board_task (a row shows #id title, "queued" when the task has not started) and follows a task being assigned or finished. The Operator's approved mock v4.
// Run against an isolated dev server, on the harness's stand-in agents and two computers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { framesJs } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const shots = process.env.CORAL_SCREENSHOT_DIR;
 const TWO = [{ id: 'm1', label: 'studio-mac', status: 'online' }, { id: 'm2', label: 'workstation', status: 'online' }];
 const task = (id, title, status = 'in_progress') => ({ id, title, status });
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
  for (const [width, mobile, listId, barId] of [[1280, false, 'live-sessions-list', 'agent-list-bar'], [390, true, 'mobile-agent-list', 'mobile-agent-list-bar']]) {
   await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile });
   await Emulation.setTouchEmulationEnabled({ enabled: mobile, maxTouchPoints: 5 });
   await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
   await ev(`localStorage.clear(); localStorage.removeItem('coral-agent-grouping'); true`); // helpers/team_grouping.js seeds the old Team choice into a harness page: this suite meets the defaults
   // The scene is also what the mock answers, so a late read of the live list cannot undo it.
   const scene = () => ev(`(() => {
    T.state.hub = true; T.state.cloud = true; T.state.servers = ${JSON.stringify(TWO)}; T.state.liveSessions = []; window.__m.agents = {};
    window.__tasks = { 'Frontend Dev': ${JSON.stringify(task(21685, 'Sidebar: Group by Task'))}, 'Backend Dev': ${JSON.stringify(task(21701, 'Unassign notifies nobody'))}, 'QA Reviewer': ${JSON.stringify(task(21650, 'Windows cdp: settings oracle'))}, 'Docs Writer': ${JSON.stringify(task(4412, 'Pairing page wording', 'pending'))} };
    const base = window.__m.entry.__base || window.__m.entry, answer = a => ({ ...base.call(window.__m, a), board_task: window.__tasks[a.name] || null }); answer.__base = base; window.__m.entry = answer;
    const add = (name, server, team, extra = {}) => window.__m.add(name, 'P', 3, { sleeping: false, server, board_project: team, display_name: name, board_is_orchestrator: name === 'Orchestrator', ...extra });
    add('Orchestrator', 'm1', 'alpha'); add('Frontend Dev', 'm1', 'alpha'); add('Backend Dev', 'm1', 'alpha'); add('QA Reviewer', 'm1', 'alpha'); add('Security', 'm1', 'alpha');
    add('Docs Writer', 'm2', 'beta'); add('Hub Lead', 'm2', 'beta'); add('Scratch', 'm2', null);
    T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
   const root = `#${listId}`;
   const shot = async name => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await ev(framesJs(3)); fs.writeFileSync(`${shots}/${name}-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } };
   const openPanel = async () => {
    await ev(`(() => { const b = [...document.querySelectorAll('[data-display-button]')].find(x => x.getClientRects().length); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`);
    await waitFor(`!!document.querySelector('#${barId} fieldset[data-group-by] input[data-box]')`, 'the Group by boxes are in the Display panel');
   };
   const listShot = async name => { if (!shots) return; const btn = `[...document.querySelectorAll('[data-display-button]')].find(x => x.getClientRects().length)`; await ev(`${btn}.click(); true`); await waitFor(`${btn}.getAttribute('aria-expanded') !== 'true'`, 'the panel closes'); await shot(name + '-list'); await openPanel(); }; // the list itself, without the panel above it
   const boxes = () => ev(`Object.fromEntries([...document.querySelectorAll('#${barId} fieldset[data-group-by] input[data-box]')].map(i => [i.dataset.box, i.checked]))`);
   const tick = k => ev(`document.querySelector('#${barId} fieldset[data-group-by] input[data-box="${k}"]').click(); true`);
   const heads = scope => ev(`[...document.querySelectorAll('${scope} .status-sub')].map(h => h.querySelector('.status-name').textContent + ' ' + h.querySelector('.session-group-count').textContent)`);
   const text = sel => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`);
   await scene();
   await waitFor(mobile ? `!!document.querySelector('${root} .status-more-toggle')` : `document.querySelectorAll('${root} .session-group-item').length >= 8`, 'the agents are listed (on a phone: the one line that counts them)');

   // 1. Three boxes, Computer, Team, Task: a viewer with no choice saved opens on Team and Task (#22104). Unticking both is the Status view, and a saved untick wins over the default.
   await openPanel();
   assert.deepEqual(await boxes(), { server: false, team: true, task: true }, `${width}: Team and Task start ticked`);
   await waitFor(`document.querySelectorAll('${root} .session-team-group').length === 2 && document.querySelectorAll('${root} .session-team-group .status-sub').length >= 3`, 'the default draws the teams split by task');
   await shot('group-by-default');
   await tick('team'); await tick('task');
   assert.deepEqual(await boxes(), { server: false, team: false, task: false }, `${width}: both unticked`);
   assert.deepEqual(await ev(`[localStorage.getItem('coral-group-team'), localStorage.getItem('coral-group-task')]`), ['false', 'false'], 'the untick is saved, so the default no longer applies');
   assert.equal(await ev(`[...document.querySelectorAll('#${barId} fieldset[data-group-by] label')].map(l => l.textContent.trim()).join()`), 'Computer,Team,Task', 'in the mock\'s order');
   assert.equal(await ev(`!!document.querySelector('#${barId} select[data-group-by]')`), false, 'the Status | Team select is gone');
   assert.equal(await ev(`!!document.querySelector('[data-display-input="group"]')`), false, 'so is the Display panel\'s Group by computer switch');
   assert.ok(await ev(`!!document.querySelector('${root} .status-head, ${root} .status-more')`) && !(await ev(`!!document.querySelector('${root} .status-sub, ${root} .session-team-group')`)), 'the Status groups, no teams and no task split');
   if (mobile) assert.ok(await ev(`[...document.querySelectorAll('#${barId} fieldset[data-group-by] label')].every(l => l.getBoundingClientRect().height >= 44)`), 'a 44px target on touch');
   await shot('group-by-status');

   // 2. Team: the teams, no task split yet.
   await tick('team');
   await waitFor(`document.querySelectorAll('${root} .session-team-group').length === 2`, 'the two teams are drawn');
   assert.equal((await heads(root)).length, 0, 'Team alone has no task split');

   // 3. Team and Task: each team splits On a task / No task, a row says #id and title, a not-started task says queued.
   await tick('task');
   await waitFor(`document.querySelectorAll('${root} .session-team-group .status-sub').length >= 3`, 'the teams split by task');
   const alpha = `${root} .session-team-group:has([data-group-name$="/alpha"])`, beta = `${root} .session-team-group:has([data-group-name$="/beta"])`;
   if (!mobile) {
    assert.deepEqual(await heads(alpha), ['On a task 3', 'No task 1'], 'alpha: three on a task, one without (its Orchestrator is the first row, in neither group, #21838)');
    assert.deepEqual(await heads(beta), ['On a task 1', 'No task 1'], 'beta');
    assert.ok((await text(`${alpha} .session-task-line`)).includes('#21685Sidebar: Group by Task'), 'a row says #number and title');
    assert.deepEqual(await text(`${beta} .status-queued`), ['queued'], 'a task that has not started says queued');
    assert.equal((await text(`${alpha} .status-queued`)).length, 0, 'an in-progress task does not');
   } else {
    // the phone: two rows of On a task, one line for the rest, one line for the agents without a task
    assert.deepEqual(await text(`${alpha} .status-more-toggle`), ['1 more on a task', '1 without a task'], 'the phone counts the rest on one line each');
    await ev(`document.querySelector('${alpha} .status-more-toggle').click(); true`);
    await waitFor(`document.querySelectorAll('${alpha} .session-group-item').length === 5`, 'the lines open the rest');
    await ev(`document.querySelector('${alpha} .status-more-toggle').click(); true`);
    await waitFor(`document.querySelectorAll('${alpha} .session-group-item').length === 3`, 'and fold again (the Orchestrator and two on a task)');
   }
   await shot('group-by-team-task'); await listShot('group-by-team-task');

   // 4. Computer too: a header per computer, the teams inside it, the split inside each team.
   await tick('server');
   await waitFor(`document.querySelectorAll('${root} li.server-group-header').length === 2`, 'a header per computer');
   const order = await ev(`[...document.querySelectorAll('${root} li.server-group-header, ${root} .session-team-group, ${root} .status-sub')].map(e => e.matches('li.server-group-header') ? 'C' : e.matches('.status-sub') ? 'T' : 'M').join('')`);
   assert.match(order, /^C(M(T)+)C/, 'computer, then team, then task: ' + order);
   await shot('group-by-computer-team-task'); await listShot('group-by-computer-team-task');

   // 5. Computer and Task without Team: the split inside each computer. Task alone: the split of the whole list.
   await tick('team');
   await waitFor(`document.querySelectorAll('${root} .session-team-group').length === 0 && document.querySelectorAll('${root} .status-sub').length === 4`, 'each computer splits by task');
   await tick('server');
   await waitFor(`document.querySelectorAll('${root} li.server-group-header').length === 0 && document.querySelectorAll('${root} .status-sub').length === 2`, 'the whole list splits by task');
   assert.deepEqual(await heads(root), ['On a task 4', 'No task 3'] /* the Orchestrator heads the list, in neither group (#21838) */);

   // 6. A task assigned, completed or reassigned moves the agent at once (the next read of the live list carries it).
   await ev(`window.__tasks['Security'] = ${JSON.stringify(task(21770, 'Review the grouping'))}; delete window.__tasks['Backend Dev']; true`);
   await ev(`window._coralLoadLiveSessions().then(() => true)`);
   await waitFor(`(() => { const h = [...document.querySelectorAll('${root} .status-sub')].map(x => x.textContent.replace(/\\s+/g, ' ').trim()); return h[0] === 'On a task4' && h[1] === 'No task3'; })()`, 'the counts follow a task assigned and one finished');
   if (!mobile) {
   const onTask = await ev(`(() => { const heads = [...document.querySelectorAll('${root} .status-sub')]; const first = heads[0]; const names = []; for (let e = first.nextElementSibling; e && !e.classList.contains('status-sub'); e = e.nextElementSibling) { const n = e.querySelector('.session-label-name'); if (n) names.push(n.textContent.trim()); } return names.sort(); })()`);
   assert.ok(onTask.includes('Security') && !onTask.includes('Backend Dev'), 'Security is on a task now and Backend Dev is not: ' + onTask);
   }
   await ev(`window.__tasks['Backend Dev'] = ${JSON.stringify(task(21701, 'Unassign notifies nobody'))}; delete window.__tasks['Security']; true`); // back, for the rest

   // 7. The choice is kept in this browser; an old Group by computer or Team choice is kept as a ticked box.
   assert.deepEqual(await boxes(), { server: false, team: false, task: true });
   await ev(`localStorage.setItem('coral-group-computer','true');localStorage.setItem('coral-group-team','true');true`);
   await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await scene();
   await openPanel();
   assert.deepEqual(await boxes(), { server: true, team: true, task: true }, 'ticked boxes are remembered across a reload');
   await ev(`localStorage.clear();localStorage.setItem('coral-group-by-server','true');localStorage.setItem('coral-agent-grouping','team');true`);
   await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await scene();
   await openPanel();
   assert.deepEqual(await boxes(), { server: true, team: true, task: false }, 'the old choices show as ticked boxes');
  }
  console.log('group_by_task_browser: ok');
 } finally { try { client.close(); } catch {} }
})().catch(e => { console.error(e); process.exit(1); });
