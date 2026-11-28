// The agent sidebar redesign (#22105, the Operator's approved mock v2, coral://artifacts/b850453a0a8df5b5da17ce745b1343f667baa48f558a16ace42a8e954d020e9c): one row shape (a state mark,
// the name, the task line with #N as the one link, the time that a hover swaps for "⋯"), quiet group headings and team line, "queued" as a grey tag, archived agents in one fold.
// The mock's roster and words, at 1280 and 390, light and dark. Run against an isolated dev server on the harness's stand-in agents.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { framesJs } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const shots = process.env.CORAL_SCREENSHOT_DIR;
 const T = (id, title, status = 'in_progress') => ({ id, title, status });
 // name, task, state (work | idle | need | sleep), staleness seconds
 const ROSTER = [
  ['Orchestrator', null, 'work', 20], ['Frontend Dev', T(412, 'Guest checkout: address form'), 'idle', 540], ['Designer', T(413, 'One-page layout at 390, with the address step folded in'), 'work', 10],
  ['Writer', T(408, 'Copy for the guest path: first-time buyer words'), 'work', 15], ['QA', T(409, 'Test plan: 12 checks for the one-page checkout'), 'need', 480],
  ['Frontend Dev 2', T(414, 'Payment step: saved cards', 'pending'), 'work', 5], ['Backend Dev', T(415, 'Order confirmation email', 'pending'), 'work', 8], ['Frontend Dev 3', T(431, 'Spring sale: banner for the first send'), 'work', 12],
  ['Reviewer', null, 'idle', 480], ['Data Analyst', null, 'idle', 780], ['Copy Editor', null, 'sleep', 240], ['Terminal 2', null, 'sleep', 86400],
 ];
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
  for (const [width, mobile, listId] of [[1280, false, 'live-sessions-list'], [390, true, 'mobile-agent-list']]) {
   await Emulation.setDeviceMetricsOverride({ width, height: 1000, deviceScaleFactor: 1, mobile });
   await Emulation.setTouchEmulationEnabled({ enabled: mobile, maxTouchPoints: 5 });
   await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
   await ev(`localStorage.clear(); localStorage.setItem('coral-group-team','true'); localStorage.setItem('coral-group-task','true'); true`);
   await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
   const scene = () => ev(`(() => {
    T.state.liveSessions = []; window.__m.agents = {};
    const R = ${JSON.stringify(ROSTER)}, by = Object.fromEntries(R.map(r => [r[0], r]));
    const base = window.__m.entry.__base || window.__m.entry, answer = a => { const r = by[a.name], e = base.call(window.__m, a); if (!r) return e; return { ...e, board_task: r[1], working: r[2] === 'work', waiting_for_input: r[2] === 'need', waiting_kind: r[2] === 'need' ? 'question' : undefined, staleness_seconds: r[3] }; };
    answer.__base = base; window.__m.entry = answer;
    for (const [name, , st] of R) window.__m.add(name, 'P', 2, { sleeping: st === 'sleep', board_project: 'shop-site', display_name: name, board_is_orchestrator: name === 'Orchestrator', agent_type: name.startsWith('Terminal') ? 'terminal' : 'claude' });
    for (const name of ['Old Dev', 'Old QA', 'Old Writer']) window.__m.add(name, 'P', 1, { archived: true, board_project: 'shop-site', display_name: name, board_is_orchestrator: false });
    T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
   await scene();
   const root = `#${listId}`;
   await waitFor(`document.querySelectorAll('${root} .session-group-item').length === 12`, `${width}: every agent is a row (no fold)`);
   const R = n => `[...document.querySelectorAll('${root} .session-group-item')].find(r => r.querySelector('.session-label').textContent.trim() === '${n}')`;
   // 1. one mark, four meanings, named
   const marks = await ev(`Object.fromEntries(['Designer','Frontend Dev','QA','Copy Editor'].map(n => { const d = [...document.querySelectorAll('${root} .session-group-item')].find(r => r.querySelector('.session-label').textContent.trim() === n).querySelector('.session-dot'); return [n, [d.getAttribute('aria-label'), d.getClientRects().length > 0]]; }))`);
   assert.deepEqual(marks, { Designer: ['Working', true], 'Frontend Dev': ['Awake, waiting', true], QA: ['Needs you', true], 'Copy Editor': ['Asleep', true] }, `${width}: the four marks ` + JSON.stringify(marks));
   // 2. the task line: #N is the one link, the title is not; no state pill in a row
   const tline = await ev(`(() => { const t = ${R('Frontend Dev')}.querySelector('.session-task-line'), a = t.querySelector('.task-id-link'); return { text: t.textContent, link: a && a.textContent, role: a && a.getAttribute('role'), links: t.querySelectorAll('[role=link], a').length, pills: document.querySelectorAll('${root} .session-group-item .session-state-pill').length }; })()`);
   assert.deepEqual(tline, { text: '#412Guest checkout: address form', link: '#412', role: 'link', links: 1, pills: 0 }, `${width}: the task line ` + JSON.stringify(tline));
   // 3. queued: a tag at the right, after the name's spacer and before the time
   assert.equal(await ev(`(() => { const r = ${R('Frontend Dev 2')}, q = r.querySelector('.status-queued'), t = r.querySelector('.session-time'); return q.textContent + ':' + (q.getBoundingClientRect().right <= t.getBoundingClientRect().left) + ':' + (q.getBoundingClientRect().left > r.querySelector('.session-label').getBoundingClientRect().right); })()`), 'queued:true:true', `${width}: "queued" sits at the right, before the time`);
   // 4. headings like the other pages, the team line quiet, archived in one fold, Group by names the grouping
   assert.deepEqual(await ev(`[...document.querySelectorAll('${root} .status-sub')].map(h => h.querySelector('.status-name').textContent + ' ' + h.querySelector('.session-group-count').textContent)`), ['On a task 7', 'No task 4'], `${width}: the headings (asleep agents stay in their group)`);
   assert.deepEqual(await ev(`(() => { const h = document.querySelector('${root} .session-team-group > .board-card-header'); return [h.querySelector('.session-group-count').textContent, !!h.querySelector('.team-group-icon, .team-health-btn')]; })()`), ['12', false], `${width}: the team line is its name and count`);
   assert.equal(await ev(`document.querySelector('${root} .archived-summary-row .row-btn').innerText.replace(/\\s+/g, ' ').trim()`), 'Archived 3 ▾', `${width}: one Archived fold`);
   assert.equal(await ev(`[...document.querySelectorAll('[data-group-by-label]')].filter(b => b.getClientRects().length).map(b => b.closest('button').textContent.replace('expand_more', '').replace(/\\s+/g, ' ').trim()).join()`), 'Group by: Team, Task', `${width}: Group by beside the search box names the grouping`);
   assert.equal(await ev(`document.querySelectorAll('[data-phone-chip], .sidebar-header[data-header="agents"] [data-group-toggle], .mobile-list-header [data-group-toggle]').length`), 0, `${width}: no status pills and no expand/collapse-all (the Orchestrator's calls 2 and 3)`);
   // 5. the time and "⋯": a hover swaps them on a wide screen; a phone shows both, the ⋯ 44 by 44, rows 48 high
   const rt = n => ev(`(() => { const r = ${R(n)}, t = r.querySelector('.session-time'), k = r.querySelector('.sidebar-kebab-btn'), kr = k.getBoundingClientRect(); return { time: t.getClientRects().length > 0, more: k.getClientRects().length > 0, w: Math.round(kr.width), h: Math.round(kr.height), row: Math.round(r.getBoundingClientRect().height) }; })()`);
   if (mobile) {
    const a = await rt('Reviewer');
    assert.ok(a.time && a.more && a.w >= 44 && a.h >= 44 && a.row >= 48, `390: time and ⋯ on every row, 44 by 44, rows 48 high ` + JSON.stringify(a));
   } else {
    assert.deepEqual(await rt('Reviewer').then(a => [a.time, a.more]), [true, false], '1280: at rest the time, no ⋯');
    const box = await ev(`(() => { const b = ${R('Writer')}.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: box.x, y: box.y }); await ev(framesJs(2));
    assert.deepEqual(await rt('Writer').then(a => [a.time, a.more]), [false, true], '1280: a hover swaps the time for ⋯');
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 700, y: 900 });
   }
   // 6. a click on #N opens the task, never the agent
   await ev(`window.__opened = []; ${R('Frontend Dev')}.querySelector('.task-id-link').click(); true`);
   assert.equal(await ev(`!!${R('Frontend Dev')}.classList.contains('active')`), false, `${width}: #N does not select the agent`);
   for (const theme of ['dark', 'light']) {
    await setTheme(ev, theme); await ev(framesJs(4));
    if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(`${shots}/agent-sidebar-${theme}-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
   }
   // 7. the states the design review asked to see (UI/UX on task #22105): a hovered row, the Archived fold open, the Group by menu open
   await ev(`document.querySelector('${root} .archived-summary-row .row-btn').click(); true`);
   await waitFor(`document.querySelector('${root}').textContent.includes('Old Dev')`, `${width}: the Archived fold opens`);
   if (!mobile) { const box = await ev(`(() => { const b = ${R('Writer')}.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`); await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: box.x, y: box.y }); }
   for (const theme of ['dark', 'light']) {
    await setTheme(ev, theme); await ev(framesJs(4));
    if (shots) fs.writeFileSync(`${shots}/agent-sidebar-${theme}-${width}-states.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
   }
   await ev(`[...document.querySelectorAll('[data-group-by-label]')].find(b => b.getClientRects().length).closest('button').click(); true`);
   await waitFor(`[...document.querySelectorAll('[data-group-by-label]')].find(b => b.getClientRects().length).closest('button').getAttribute('aria-expanded') === 'true'`, `${width}: Group by opens its menu`);
   for (const theme of ['dark', 'light']) {
    await setTheme(ev, theme); await ev(framesJs(4));
    if (shots) fs.writeFileSync(`${shots}/agent-sidebar-${theme}-${width}-groupby.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
   }
  }
  console.log('PASS agent sidebar (#22105): four marks, #N the one link, queued at the right, the time/⋯ swap, quiet headings and team line, one Archived fold, Group by named; 1280 and 390, light and dark');
 } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
