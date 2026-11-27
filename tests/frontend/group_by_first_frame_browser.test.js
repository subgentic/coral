// #21784: a browser that opens with Computer, Team or Task ticked never paints the grouped list before group_by.css is in. The sheet is held (the request is paused), the page loads with Task ticked,
// the agents are listed: no task split is drawn while the sheet is out; once it arrives the split is drawn and styled (its sub-heading has no bullet and an indent).
// Run against an isolated dev server, on the harness's stand-in agents.
const assert = require('node:assert/strict');
const { framesJs } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const { safePaused } = require('./helpers/paused');
(async () => {
 const { client, Page, ev, waitFor, PRELOAD } = await connect();
 const { Fetch } = client;
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
  // the page that meets the choice: Task ticked (the harness's old Team choice is taken off), three agents in the mocked list from the first read
  await Page.addScriptToEvaluateOnNewDocument({ source: `try { localStorage.removeItem('coral-agent-grouping'); localStorage.setItem('coral-group-task', 'true'); } catch {} const RealTimeout = window.setTimeout; window.setTimeout = function (f, ms, ...a) { return ms === 3000 ? 0 : RealTimeout.call(this, f, ms, ...a); }; /* lazy_styles' 3 s give-up never fires, so the held sheet stays held however slow the machine is */ const Real = window.WebSocket; function Dead(u) { this.url = String(u); this.readyState = 0; } Dead.prototype.send = Dead.prototype.close = Dead.prototype.addEventListener = Dead.prototype.removeEventListener = function () {}; function W(u, p) { return /\\/ws\\/(coral|terminal)/.test(String(u)) ? new Dead(u) : p === undefined ? new Real(u) : new Real(u, p); } W.prototype = Real.prototype; W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3; window.WebSocket = W; // no feed: its first update would replace the mocked list with the test server's empty one
  window.__qaSeed = ['a1', 'a2', 'a3'].map(n => ({ name: n, prefix: 'P', n: 3, sleeping: false, display_name: n }));` });
  let held = null; const seen = [];
  safePaused(client, e => { seen.push(e.request.url); held = e.requestId; }); // the one request stays paused until the test lets it go
  await Fetch.enable({ patterns: [{ urlPattern: '*/css/group_by.css', requestStage: 'Request' }] });
  await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired();
  await waitFor(`!!window.__liveListServed`, 'the page has read its list');
  for (let i = 0; i < 400 && !held; i++) await ev(framesJs(1)); // the sheet's request is out (the page asked for it)
  await ev(framesJs(6)); // and a few frames pass with it held
  assert.ok(held, 'the page asked for group_by.css: ' + JSON.stringify(seen));
  assert.equal(await ev(`!!document.querySelector('#live-sessions-list .status-sub')`), false, 'no task split is drawn while its sheet is still out');
  assert.equal(await ev(`document.querySelectorAll('#live-sessions-list .session-group-item').length`), 0, 'nor any unstyled row of the grouped list');
  await Fetch.continueRequest({ requestId: held });
  await waitFor(`!!document.querySelector('#live-sessions-list .status-sub')`, 'the task split is drawn once the sheet is in');
  const st = await ev(`(() => { const h = document.querySelector('#live-sessions-list .status-sub'), c = getComputedStyle(h); return { list: c.listStyleType, indent: parseFloat(c.paddingInlineStart) }; })()`);
  assert.equal(st.list, 'none', 'styled: ' + JSON.stringify(st)); assert.ok(st.indent > 0, 'indented: ' + JSON.stringify(st));
  await Fetch.disable();
  console.log('group_by_first_frame_browser: ok');
 } finally { try { client.close(); } catch {} }
})().catch(e => { console.error(e); process.exit(1); });
