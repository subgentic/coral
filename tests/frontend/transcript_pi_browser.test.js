// Transcript chat of a Pi agent, end to end (#11088): a real Pi 1.4.0 session file, every text replaced
// (coral-go/internal/jsonl/testdata/pi-1.4.0/session.jsonl), is placed where Coral's Pi launch puts Pi's
// session (<data dir>/pi-sessions/<session id>/) in the isolated test server's data folder and read through
// the real /chat endpoint. Before the Pi reader existed a Pi agent's chat stayed empty. Checks: the user turns
// and the assistant replies show, the tool calls fold into a work group with their commands and outputs, the
// turn Pi ended with an error is shown, the system prompt entry is not. Then appends a turn while the chat is
// open to check live polling.
const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');
const BASE = require('./test_base').BASE;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const DATA = process.env.CORAL_TEST_DATA_DIR || '';
if (!DATA) { console.error('run under run_cdp_suites.mjs (CORAL_TEST_DATA_DIR names the isolated server\'s folder)'); process.exit(2); }
const results = []; const check = (l, c, d) => { const v = c ? 'PASS' : 'FAIL'; results.push(v); console.log(`[${v}] ${l}${d !== undefined ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SID = require('crypto').randomUUID();
const FIXTURE = path.join(__dirname, '..', '..', 'coral-go', 'internal', 'jsonl', 'testdata', 'pi-1.4.0', 'session.jsonl');
const SESSION_DIR = path.join(DATA, 'pi-sessions', SID);
const FILE = path.join(SESSION_DIR, '2026-10-29T19-44-35-010Z_01a18931-58c2-74fc-8a74-bed622970705.jsonl');
fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
fs.copyFileSync(FIXTURE, FILE);
const append = (...rows) => fs.appendFileSync(FILE, rows.map(r => JSON.stringify(r) + '\n').join(''));

const SESSIONS = [{ name: 'pi-dev', display_name: 'Pi Dev', agent_type: 'pi', session_id: SID, summary: 'Working', working_directory: '/work/pi-project' }];

// Only the session list is stubbed; /chat goes to the real test server.
const STUB = `
  window.__sessions = ${JSON.stringify(SESSIONS)}; window.__chatFetches = 0;
  (function(){ const Real = window.WebSocket; function Dead(u){ this.url=String(u); this.readyState=0; } Dead.prototype.send=function(){}; Dead.prototype.close=function(){}; Dead.prototype.addEventListener=function(){}; Dead.prototype.removeEventListener=function(){};
    function W(u,p){ if (/\\/ws\\//.test(String(u))) return new Dead(u); return p===undefined? new Real(u): new Real(u,p); } W.prototype=Real.prototype; W.CONNECTING=0; W.OPEN=1; W.CLOSING=2; W.CLOSED=3; window.WebSocket=W; })();
  window.__origFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => { const u=String(url); const rel=u.replace(/^https?:\\/\\/[^/]+/,''); const p=rel.split('?')[0]; const m=((opts&&opts.method)||'GET').toUpperCase();
    const json=(b)=>Promise.resolve(new Response(JSON.stringify(b),{status:200,headers:{'Content-Type':'application/json'}}));
    if (p==='/api/sessions/live' && m==='GET') return json(window.__sessions);
    if (/\\/chat$/.test(p)) window.__chatFetches++;
    return window.__origFetch(url, opts); };`;

async function run() {
  const client = await CDP({ port: CDP_PORT }); const { Page, Runtime, Emulation } = client;
  await Promise.all([Page.enable(), Runtime.enable()]);
  await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
  const ev = async (x) => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  await Emulation.setDeviceMetricsOverride({ width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
  await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
  for (let i = 0; i < 50; i++) { if (await ev(`typeof window._coralSetLiveSessions === 'function' && typeof window.selectLiveSession === 'function'`)) break; await sleep(100); }
  await ev(`window.switchNavTab('agents'); window._coralSetLiveSessions(JSON.parse(JSON.stringify(window.__sessions))); true`);
  await ev(`Promise.resolve(window.selectLiveSession('pi-dev', 'pi', ${JSON.stringify(SID)})).then(() => { window.setLiveViewMode('chat'); return true; })`);
  for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('#live-history-messages .message-text')`)) break; await sleep(100); }

  const C = `document.getElementById('live-history-messages')`;
  // The chat opens on the newest page of messages: the fixture has 38, so load the older pages first (the "load more" button at the top).
  for (let i = 0; i < 10; i++) { const more = await ev(`(() => { const b = document.querySelector('#live-history-messages .load-more-btn'); if (!b) return false; b.click(); return true; })()`); if (!more) break; await sleep(400); /* sleep-ok: the interval of a bounded loop that clicks Load more until the button is gone */ }
  const text = () => ev(`${C}.innerText`);
  const userTurns = () => ev(`Array.from(${C}.querySelectorAll('.human .message-text')).map(e => e.innerText.trim())`);

  check('chat history came from the real /chat endpoint', (await ev(`window.__chatFetches`)) > 0);
  const users = await userTurns();
  check('the four user turns show, in order', JSON.stringify(users) === JSON.stringify([1, 2, 3, 4].map(n => `FIXTURE-USER-${n} question`)), JSON.stringify(users));
  const all = await text();
  check('the assistant replies show', [1, 2, 3].every(n => all.includes(`FIXTURE-ASSISTANT-${n} answer`)));
  check('the system prompt entry is not a turn', !all.includes('FIXTURE-SYSTEM'));
  check('the turn Pi ended with an error is shown', all.includes('invalid_request_error'));

  // Open every work group: the tool calls with their commands and outputs.
  await ev(`${C}.querySelectorAll('.work-group').forEach(g => { g.open = true; }); true`);
  for (let i = 0; i < 30; i++) { if (await ev(`!!${C}.querySelector('.tool-card-command, .tool-card-output')`)) break; await sleep(100); } // the opened groups have drawn their cards
  const calls = await ev(`Array.from(${C}.querySelectorAll('.tool-call')).map(d => ({ id: d.dataset.toolUseId || null, name: d.querySelector('.tool-call-name').getAttribute('data-tool') || d.querySelector('.tool-call-name').textContent,
      command: (d.querySelector('.tool-card-command')||{}).textContent || null, output: (d.querySelector('.tool-card-output')||{}).textContent || null }))`);
  check('the Pi tool calls show as tool rows', calls.length >= 12, String(calls.length));
  check('a bash call shows its command and its output', calls.some(c => /^echo FIXTURE-CMD-/.test(c.command || '') && /^FIXTURE-RESULT-/.test(c.output || '')), JSON.stringify(calls.slice(0, 2)));
  // The chat pages by message count with no regard for a call and its result: the one call whose result sits across a page boundary shows as a call without output next to a result row (any agent's chat).
  // What matters here is that all fifteen results are in the chat and all but that one are on their calls.
  const outs = calls.map(c => c.output).filter(Boolean);
  check('all fifteen tool results are in the chat', [...Array(15).keys()].every(n => outs.includes(`FIXTURE-RESULT-${n + 1}`)), String(outs.length));
  check('every call has its output but the one a page boundary splits', calls.filter(c => c.id && !c.output).length <= 1, JSON.stringify(calls.filter(c => c.id && !c.output)));

  // Live: a turn appended while the chat is open appears.
  append({ type: 'message', id: 'ffff0001', parentId: null, timestamp: '2026-10-29T20:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'FIXTURE-USER-LIVE question' }], timestamp: 1793306400000 } },
         { type: 'message', id: 'ffff0002', parentId: 'ffff0001', timestamp: '2026-10-29T20:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'FIXTURE-ASSISTANT-LIVE answer' }], api: 'openai-responses', provider: 'openai', model: 'gpt-6-luna', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 1793306402000 } });
  let live = '';
  for (let i = 0; i < 40; i++) { live = await text(); if (live.includes('FIXTURE-ASSISTANT-LIVE answer')) break; await sleep(250); /* sleep-ok: the interval of a bounded loop that waits for the live answer to be drawn */ }
  check('a turn written while the chat is open appears', live.includes('FIXTURE-USER-LIVE question') && live.includes('FIXTURE-ASSISTANT-LIVE answer'));

  await client.close();
  const failed = results.filter(r => r === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(2); });
