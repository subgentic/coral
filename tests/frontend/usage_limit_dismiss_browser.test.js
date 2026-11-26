// #21676: the usage-limit summary can be dismissed (per browser, until the limited agents or their reset time change).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { framesJs } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const shots = process.env.CORAL_SCREENSHOT_DIR;
 const now = new Date(); now.setUTCHours(12, 0, 0, 0);
 const reset = new Date(now.getTime() + 3 * 3600e3).toISOString(), reset2 = new Date(now.getTime() + 5 * 3600e3).toISOString();
 const row = (id, name, team, extra = {}) => ({ session_id: id, name, display_name: name, agent_type: 'claude', working_directory: '/work/' + team, working: false, sleeping: false, done: false, awaiting_user: false, board_project: team, ...extra });
 const limited = (id, name, at) => row(id, name, 'solo', { agent_type: 'agy', blocked: { kind: 'usage_limit', vendor: 'agy', reset_at: at } });
 const rows = (at, more) => [
  row('lead', 'Lead Developer', 'north-team', { working: true }),
  ...[1, 2, 3].map(i => row('n' + i, 'North Sleeper ' + i, 'north-team', { sleeping: true })),
  ...[1, 2].map(i => row('e' + i, 'East Sleeper ' + i, 'east-team', { sleeping: true })),
  limited('agy', 'Researcher', at), ...(more ? [limited('agy2', 'Researcher 2', at)] : []),
 ];
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
  for (const [width, mobile, root] of [[1280, false, '#live-sessions-list'], [390, true, '#mobile-session-list']]) {
   await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile });
   await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
   await waitFor(`document.querySelectorAll('${root} .empty-launch').length===3`, 'the empty list shows its launch cards');
   const draw = (at, more) => ev(`(()=>{const start=performance.now();Date.now=()=>${now.getTime()}+performance.now()-start;T.state.liveSessions=${JSON.stringify(rows(at, more))};T.render.renderLiveSessions(T.state.liveSessions);return true})()`);
   const shot = async name => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await ev(framesJs(3)); fs.writeFileSync(`${shots}/${name}-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } };
   for (const mode of ['team', 'status']) {
    await ev(`localStorage.removeItem('coral-usage-limit-dismissed');localStorage.setItem('coral-agent-grouping','${mode}');true`);
    await draw(reset); await waitFor(`!!document.querySelector('${root} .usage-limit-heading')`, 'the waiting section is drawn');
    await shot('limit-' + mode);
    // 1: the summary can be dismissed, with a 44px control on touch.
    const btn = await ev(`(()=>{const b=document.querySelector('${root} .usage-limit-summary .usage-limit-dismiss');if(!b)return null;const r=b.getBoundingClientRect();return {w:r.width,h:r.height,label:b.getAttribute('aria-label')}})()`);
    assert.ok(btn, `${mode} ${width}: the summary has a dismiss button`);
    assert.match(btn.label, /dismiss/i);
    if (mobile) assert.ok(btn.w >= 44 && btn.h >= 44, `a 44px target on touch, got ${btn.w}x${btn.h}`);
    await ev(`document.querySelector('${root} .usage-limit-summary .usage-limit-dismiss').click();true`);
    await waitFor(`!document.querySelector('${root} .usage-limit-summary')`, 'the summary is gone after the dismiss');
    assert.ok(await ev(`!!document.querySelector('${root} .usage-limit-heading')&&document.querySelector('${root} [data-session-id="agy"]').dataset.state==='usage_limit'`), 'the waiting section and the row pill stay');
    await draw(reset); assert.equal(await ev(`!!document.querySelector('${root} .usage-limit-summary')`), false, 'a redraw keeps it dismissed');
    assert.ok(await ev(`!!localStorage.getItem('coral-usage-limit-dismissed')`), 'kept per browser');
    await ev(`localStorage.setItem('coral-usage-limit-dismissed','{broken');true`); // unreadable memory: the summary shows again, nothing throws
    await draw(reset);
    await ev(`document.querySelector('${root} .usage-limit-summary .usage-limit-dismiss').click();true`);
    await draw(reset2); assert.equal(await ev(`!!document.querySelector('${root} .usage-limit-summary')`), true, 'a new reset time brings it back');
    await ev(`document.querySelector('${root} .usage-limit-summary .usage-limit-dismiss').click();true`);
    await draw(reset); await draw(reset, true); assert.equal(await ev(`!!document.querySelector('${root} .usage-limit-summary')`), true, 'another limited agent brings it back');
    await shot('limit-' + mode + '-again');
   }
  }
  console.log('usage_limit_dismiss_browser: ok');
 } finally { try { client.close(); } catch {} }
})().catch(e => { console.error(e); process.exit(1); });
