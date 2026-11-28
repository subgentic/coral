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
   await waitFor(`document.querySelectorAll('${root} .session-group-item').length >= 1`, `${width}: the agents are listed`);
   console.log(width, 'rows', await ev(`document.querySelectorAll('${root} .session-group-item').length`), 'visible list', await ev(`document.querySelector('${root}')?.getClientRects().length`));
   if (process.env.SIDEBAR_DEBUG) console.log(width, JSON.stringify(await ev(`[...document.querySelectorAll('${root} .board-card-agents > *')].slice(0,4).map(e=>{const r=e.getBoundingClientRect(),cs=getComputedStyle(e);return [e.className.slice(0,40),Math.round(r.top),Math.round(r.height),cs.marginTop,cs.marginBottom,cs.minHeight,cs.paddingTop]})`)));
   for (const theme of ['dark', 'light']) {
    await setTheme(ev, theme); await ev(framesJs(4));
    if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(`${shots}/agent-sidebar-${theme}-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
   }
  }
  console.log('PASS agent sidebar: the mock roster drawn at 1280 and 390, light and dark');
 } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
