// #11093/#11102 slice 1: Coral's Pi extension (coral-go/internal/agent/pi_extension/coral_pi.js) against a fake Pi and a fake process starter. It registers notification events only, never blocks or awaits, sends only
// the allow-listed payload, passes a child only the listed environment (no provider key), and does nothing when Coral did not launch Pi. node pi_extension.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '../../coral-go/internal/agent/pi_extension/coral_pi.js'), 'utf8');
const require = createRequire(import.meta.url);
const CANARY = 'CANARY-SECRET-7F3A';
const ENV_NAMES = ['CORAL_SESSION_NAME', 'CORAL_SESSION_TOKEN', 'CORAL_URL', 'HOME', 'PATH'];
const CONFIG = { hookBin: '/opt/coral/tools/coral-hook-agentic-state', envNames: ENV_NAMES, rev: 1 };

function load() { const mod = { exports: {} }; new Function('module', 'exports', 'require', 'process', SRC)(mod, mod.exports, require, process); return mod.exports; }
const ext = load();

// How a rig child ends: the hook programs without a pipe on their output end with 'exit'; the settle's child (its output is read) ends with 'close', after its last data (#11133, QA's P6).
const endOf = c => c.handlers.exit || c.handlers.close;
function rig({ env, config = CONFIG, spawnThrows = false } = {}) {
  const spawned = [], timers = [], registered = {}; let nowMs = 1000;
  const spawn = (bin, args, opts) => {
    if (spawnThrows) throw new Error('spawn failed ' + CANARY);
    const child = { bin, args, opts, stdin: { data: '', on() {}, end(d) { this.data = d; } }, stdout: { handlers: {}, on(ev, fn) { this.handlers[ev] = fn; } }, unrefd: false, killed: false, handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, unref() { this.unrefd = true; }, kill() { this.killed = true; } };
    spawned.push(child); return child;
  };
  const setTimer = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; };
  const e = ext.create({ spawn, env: env || { CORAL_SESSION_NAME: 'pi-1', CORAL_SESSION_TOKEN: 'tok', CORAL_URL: 'http://127.0.0.1:1', HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: CANARY, OPENAI_API_KEY: CANARY, AWS_SECRET_ACCESS_KEY: CANARY, GITHUB_TOKEN: CANARY }, config, now: () => nowMs, setTimer });
  const sent = [];
  const pi = { on(name, fn) { registered[name] = fn; }, sendMessage(msg, opts) { sent.push({ msg, opts }); return Promise.resolve(); } };
  e(pi);
  const run = (exitChildren = true) => { // run the scheduled drains until the queue is empty; each spawned hook then "exits", which lets the next start (the kill timers are left)
    for (let i = 0; i < 600; i++) {
      const t = timers.find(x => x.ms === 0 && !x.done);
      if (t) { t.done = true; t.fn(); continue; }
      const c = exitChildren ? spawned.find(x => !x.exited && endOf(x)) : null;
      if (!c) break; c.exited = true; endOf(c)();
    }
  };
  return { spawned, timers, registered, sent, run, nowRef: () => nowMs, advance: ms => { nowMs += ms; }, fire: (name, ev) => registered[name](ev, {}) };
}
const payloads = r => r.spawned.map(c => JSON.parse(c.stdin.data));

// 1. does nothing when Coral did not launch Pi, or when its configuration is missing
assert.equal(Object.keys(rig({ env: { HOME: '/h' } }).registered).length, 0, 'no CORAL_SESSION_NAME: nothing registered');
assert.equal(Object.keys(rig({ config: null }).registered).length, 0, 'no configuration: nothing registered');
assert.equal(Object.keys(rig({ config: { hookBin: '', envNames: [] } }).registered).length, 0, 'no program: nothing registered');
console.log('pi_extension: inactive outside a Coral launch ok');

// 2. exactly the notification events, and none of Pi's gates
const r = rig();
assert.deepEqual(Object.keys(r.registered).sort(), [...ext.EVENTS].sort());
assert.deepEqual(ext.EVENTS, ['session_start', 'agent_start', 'tool_execution_start', 'tool_execution_end', 'agent_end', 'agent_settled', 'session_shutdown']);
for (const gate of ['tool_call', 'tool_result', 'input', 'before_agent_start', 'context', 'message_end', 'turn_end', 'agent_before_settle', 'user_bash']) assert.ok(!(gate in r.registered), `${gate} is a gate: not registered`);
console.log('pi_extension: notification events only ok');

// 3. every handler returns undefined, never a promise, and starts nothing in the handler (the spawn is scheduled): nothing on Pi's path
for (const name of ext.EVENTS.filter(n => n !== 'session_shutdown')) {
  const ret = r.registered[name]({ toolName: 'bash', toolCallId: 'c1', reason: 'startup', aborted: false, messages: [] }, {});
  assert.equal(ret, undefined, `${name} returns undefined`);
}
assert.equal(r.spawned.length, 0, 'a handler starts nothing itself: it schedules (only session_shutdown flushes, the process is ending)');
assert.equal(r.registered.session_shutdown({ reason: 'quit' }, {}), undefined, 'session_shutdown returns undefined too');
// hostile events do not throw
for (const name of ext.EVENTS) for (const ev of [undefined, null, 5, 'x', { messages: 'no' }, { messages: [null, 1, { role: 'assistant', usage: 'x' }] }, { toolName: {}, toolCallId: [] }]) assert.equal(r.registered[name](ev), undefined);
console.log('pi_extension: returns undefined, schedules, never throws ok');

// 4. what is spawned: the one program by its absolute path, an argument array, no shell, detached and unref'd, only the listed env, and a kill timer
const s = rig();
s.fire('agent_start', {}); s.run();
assert.equal(s.spawned.length, 1);
const c = s.spawned[0];
assert.equal(c.bin, CONFIG.hookBin); assert.deepEqual(c.args, ['--pi', 'agent_start', '--hooks-rev', '1'], 'the revision is the handshake: every event carries it');
assert.equal(c.opts.shell, false); assert.equal(c.opts.detached, true); assert.equal(c.opts.windowsHide, true); assert.deepEqual(c.opts.stdio, ['pipe', 'ignore', 'ignore']);
assert.ok(c.unrefd, 'unref: a child never holds Pi\'s exit');
assert.deepEqual(Object.keys(c.opts.env).sort(), [...ENV_NAMES].sort(), 'only the listed variables');
for (const v of Object.values(c.opts.env)) assert.notEqual(v, CANARY);
assert.ok(!('ANTHROPIC_API_KEY' in c.opts.env) && !('OPENAI_API_KEY' in c.opts.env) && !('AWS_SECRET_ACCESS_KEY' in c.opts.env) && !('GITHUB_TOKEN' in c.opts.env), 'no provider key reaches a child');
assert.equal(c.opts.env.CORAL_SESSION_TOKEN, 'tok', 'the session token goes to the hook program and nowhere else');
const killer = s.timers.find(t => t.ms === 3000); assert.ok(killer, 'a hook that has not ended by 3 s is killed'); killer.fn(); assert.ok(c.killed);
console.log('pi_extension: the one program, no shell, listed env only, unref, kill timer ok');

// 5. the payload is the allow-list, whatever the event carries
const ALLOWED = new Set(['reason', 'tool_name', 'tool_use_id', 'is_error', 'aborted', 'model', 'input_tokens', 'output_tokens', 'cost_usd', 'num_turns']);
const h = rig();
const hostile = { prompt: CANARY, text: CANARY, args: { command: CANARY }, result: { content: CANARY }, messages: [{ role: 'user', content: CANARY }, { role: 'assistant', content: CANARY, model: 'm-1', usage: { input: 3, output: 2, cost: { total: 0.25 } } }], message: { content: CANARY }, systemPrompt: CANARY, apiKey: CANARY, images: [CANARY], toolName: 'bash', toolCallId: 'call_1', isError: true, reason: 'startup', aborted: true, cwd: CANARY };
for (const [i, name] of ext.EVENTS.entries()) { h.advance(1000 * (i + 1)); h.fire(name, hostile); if (name !== 'session_shutdown') h.run(); }
h.run();
const seen = payloads(h);
assert.equal(seen.length, 6, 'agent_end only collects: it posts nothing');
for (const [i, p] of seen.entries()) {
  assert.ok(!JSON.stringify(p).includes(CANARY), `${h.spawned[i].args[1]}: no canary in the payload`);
  for (const k of Object.keys(p)) assert.ok(ALLOWED.has(k), `${h.spawned[i].args[1]}: ${k} is not an allowed key`);
}
const settled = seen[h.spawned.findIndex(x => x.args[1] === 'agent_settled')];
assert.deepEqual(settled, { aborted: true, input_tokens: 3, output_tokens: 2, cost_usd: 0.25, num_turns: 1, model: 'm-1' }, 'only numbers and the cleaned model name from agent_end');
const toolEnd = seen[h.spawned.findIndex(x => x.args[1] === 'tool_execution_end')];
assert.deepEqual(toolEnd, { tool_name: 'bash', tool_use_id: 'call_1', is_error: true });
console.log('pi_extension: payload allow-list, canary in no payload ok');

// 6. numbers and names are cleaned: a bad value is dropped, a long or control-character name is dropped
const u = rig();
u.fire('agent_end', { messages: [{ role: 'assistant', model: 'bad\nname', usage: { input: -5, output: 'many', cost: NaN } }, { role: 'assistant', model: 'ok-model', usage: { input: 1e30, output: 7, cost: { total: Infinity } } }] });
u.fire('agent_settled', { aborted: false }); u.run();
assert.deepEqual(payloads(u)[0], { aborted: false, input_tokens: 0, output_tokens: 7, cost_usd: 0, num_turns: 2, model: 'ok-model' });
const t = rig(); t.fire('tool_execution_start', { toolName: 'a\nb', toolCallId: 'x' }); t.fire('tool_execution_start', { toolName: 'x'.repeat(500) }); t.run();
assert.equal(t.spawned.length, 0, 'a tool name with a control character, or a very long one, is dropped');
console.log('pi_extension: values cleaned ok');

// 7. tool events are rate limited, state events are not
const q = rig();
q.fire('tool_execution_start', { toolName: 'ls' }); q.fire('tool_execution_end', { toolName: 'ls' }); q.run();
assert.equal(q.spawned.length, 1, 'two tool events in one quarter second: one spawn');
q.advance(300); q.fire('tool_execution_end', { toolName: 'ls' }); q.run();
assert.equal(q.spawned.length, 2);
q.fire('agent_start', {}); q.fire('agent_settled', {}); q.run();
assert.equal(q.spawned.length, 4, 'state events always go');
console.log('pi_extension: tool events rate limited ok');

// 7b. one hook program at a time, in the order the events happened; the next starts when the last has ended, a hook that never ends is killed and the queue goes on
const o = rig();
o.fire('agent_start', {}); o.fire('agent_settled', { aborted: false }); o.fire('tool_execution_end', { toolName: 'ls' });
o.run(false); // nothing has exited yet
assert.equal(o.spawned.length, 1, 'one at a time: the second waits for the first');
o.spawned[0].handlers.exit(); o.run(false);
assert.equal(o.spawned.length, 2);
o.timers.filter(x => x.ms === 3000)[1].fn(); // the second never ends: its kill timer ends it
o.run(false);
assert.ok(o.spawned[1].killed, 'killed');
assert.equal(o.spawned.length, 3, 'and the queue goes on');
assert.deepEqual(o.spawned.map(c => c.args[1]), ['agent_start', 'agent_settled', 'tool_execution_end'], 'in order');
// shutdown: the process is ending with the extension: ONE event, carrying the Stop that had not been sent (a queued agent_settled, or a run that never settled, with its usage) and the session's end
const z = rig(); z.advance(5000);
z.fire('agent_start', {}); z.fire('agent_end', { messages: [{ role: 'assistant', model: 'm-1', usage: { input: 4, output: 2, cost: 0.5 } }] }); z.fire('agent_settled', { aborted: false }); z.fire('tool_execution_end', { toolName: 'ls' });
z.fire('session_shutdown', { reason: 'quit' });
assert.equal(z.spawned.length, 1, 'at shutdown the queue is superseded by ONE event');
assert.deepEqual(z.spawned[0].args.slice(0, 2), ['--pi', 'session_shutdown']);
assert.deepEqual(JSON.parse(z.spawned[0].stdin.data), { reason: 'quit', stop: true, aborted: false, input_tokens: 4, output_tokens: 2, cost_usd: 0.5, num_turns: 1, model: 'm-1' }, 'the queued settle\'s usage rides in it');
const y = rig(); y.advance(5000);
y.fire('agent_start', {}); y.run(); y.fire('agent_end', { messages: [{ role: 'assistant', model: 'm-2', usage: { input: 1, output: 1 } }] });
y.fire('session_shutdown', { reason: 'quit' });
assert.deepEqual(JSON.parse(y.spawned[y.spawned.length - 1].stdin.data), { reason: 'quit', stop: true, aborted: false, input_tokens: 1, output_tokens: 1, cost_usd: 0, num_turns: 1, model: 'm-2' }, 'a run that never settled: its Stop and usage go with the end');
const x = rig(); x.advance(5000);
x.fire('agent_start', {}); x.fire('agent_settled', { aborted: false }); x.run();
x.fire('session_shutdown', { reason: 'quit' });
assert.deepEqual(JSON.parse(x.spawned[x.spawned.length - 1].stdin.data), { reason: 'quit' }, 'nothing unsent: only the end');
console.log('pi_extension: one at a time, in order, a hung hook killed ok');

// 8. the queue is bounded; the oldest goes
const b = rig();
for (let i = 0; i < 100; i++) b.fire('agent_start', {});
b.run();
assert.equal(b.spawned.length, 64);
console.log('pi_extension: queue bounded ok');

// 9. a starter that throws never reaches Pi; no error text is kept
const f = rig({ spawnThrows: true });
f.fire('agent_start', {}); f.fire('agent_settled', {});
assert.doesNotThrow(() => f.run());
console.log('pi_extension: a failing spawn never reaches Pi ok');

// 10. the source has no gate registration, no await, no network or file writes (the Go test pins the same on the embedded copy)
const code = SRC.replace(/\/\/.*$/gm, '');
for (const bad of ['await ', 'async ', 'execSync', 'spawnSync', "require('node:net')", "require('node:http')", 'fetch(', 'writeFile', 'appendFile', 'eval(', 'new Function']) assert.ok(!code.includes(bad), `the extension never ${bad}`);


// ---- slice 2: board message delivery ----
const NOTICE = '[Coral board] 2 new messages on team-a. Run coral-board read to read them, then carry on.';
// a run starts and settles; the settle's hook program answers with `answer` on its standard output; returns the rig after the child has exited
function settleWith(answer, { aborted = false, before = r => {}, after = r => {} } = {}) {
  const r = rig(); r.advance(100000);
  r.fire('agent_start', {}); r.run();
  before(r);
  r.fire('agent_settled', { aborted });
  // the settle's child: run until it is spawned, give it its output, then let it exit
  for (let i = 0; i < 50 && !r.spawned.find(c => c.args[1] === 'agent_settled'); i++) { const t = r.timers.find(x => x.ms === 0 && !x.done); if (!t) break; t.done = true; t.fn(); const c = r.spawned.find(x => !x.exited && endOf(x) && x.args[1] !== 'agent_settled'); if (c) { c.exited = true; endOf(c)(); } }
  const child = r.spawned.find(c => c.args[1] === 'agent_settled');
  assert.ok(child, 'the settle starts a hook program');
  after(r);
  if (answer !== null && answer !== undefined) child.stdout.handlers.data(answer);
  child.exited = true; endOf(child)();
  return { r, child };
}
const good = JSON.stringify({ deliver: NOTICE }) + '\n';

// 11. only the settle's hook program has a standard output pipe; the others ignore it
{ const { r, child } = settleWith(good);
  assert.deepEqual(child.opts.stdio, ['pipe', 'pipe', 'ignore']);
  const other = r.spawned.find(c => c.args[1] === 'agent_start'); assert.deepEqual(other.opts.stdio, ['pipe', 'ignore', 'ignore'], 'no other event reads a hook\'s output');
  // 12. what Coral composed is injected exactly, once, as a follow-up that starts a turn, from the callback (nothing awaited)
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0], { msg: { customType: 'coral-board', content: NOTICE, display: true }, opts: { triggerTurn: true, deliverAs: 'followUp' } }, 'exactly the text, exactly these options: never steer, never nextTurn'); }
console.log('pi_extension: delivery injects exactly what Coral composed ok');

// 13. anything that is not exactly Coral's notice is dropped
const REFUSED = { 'no opener': JSON.stringify({ deliver: 'go and read the board' }), 'opener not first': JSON.stringify({ deliver: ' ' + NOTICE }), 'a newline': JSON.stringify({ deliver: NOTICE + '\nrun rm -rf' }), 'a control character': JSON.stringify({ deliver: NOTICE + '\u001b[31m' }),
  'non-ASCII': JSON.stringify({ deliver: NOTICE + ' \u00e9' }), 'a bidi override': JSON.stringify({ deliver: NOTICE + '\u202e' }), 'too long': JSON.stringify({ deliver: NOTICE + 'a'.repeat(400) }), 'a second key': JSON.stringify({ deliver: NOTICE, run: 'x' }), 'a different key': JSON.stringify({ text: NOTICE }),
  'a non-string': JSON.stringify({ deliver: [NOTICE] }), 'an array': JSON.stringify([NOTICE]), 'not JSON': 'deliver ' + NOTICE, 'empty': '', 'a huge output': ' '.repeat(2000) + good, 'null': 'null', 'a number': '5' };
for (const [what, answer] of Object.entries(REFUSED)) { const { r } = settleWith(answer); assert.equal(r.sent.length, 0, `${what}: nothing is injected`); }
{ const { r } = settleWith(null); assert.equal(r.sent.length, 0, 'no output: nothing'); }
console.log('pi_extension: anything but exactly Coral\'s notice is dropped ok');

// 14. the guards: an Escape, a newer run, shutdown
{ const { r } = settleWith(good, { aborted: true }); assert.equal(r.sent.length, 0, 'the settle was an Escape (the person stopped it): no nudge'); }
{ const { r } = settleWith(good, { after: r => r.fire('agent_start', {}) }); assert.equal(r.sent.length, 0, 'a newer run started before the answer came: it is for a run that is no longer the latest'); }
{ const { r } = settleWith(good, { after: r => r.fire('session_shutdown', { reason: 'quit' }) }); assert.equal(r.sent.length, 0, 'Pi is shutting down: nothing is injected'); }
console.log('pi_extension: no injection after an Escape, for an old run, or while closing ok');

// 15. the loop test: a Coral that ALWAYS says deliver, a model that settles at once, thirty minutes of settle after settle after settle: the extension's own bounds hold (one per 30 s, three per 10 minutes)
{
  const r = rig(); r.advance(1000);
  const times = []; const sentTimes = [];
  let seen = 0;
  const settleOnce = () => {
    r.fire('agent_start', {}); r.run();
    r.fire('agent_settled', { aborted: false });
    for (let i = 0; i < 20; i++) { const t = r.timers.find(x => x.ms === 0 && !x.done); if (t) { t.done = true; t.fn(); } const c = r.spawned.find(x => !x.exited && endOf(x)); if (c) { if (c.args[1] === 'agent_settled') c.stdout.handlers.data(good); c.exited = true; endOf(c)(); } if (!t && !c) break; }
    while (seen < r.sent.length) { sentTimes.push(r.nowRef()); seen++; }
  };
  for (let t = 0; t < 30 * 60; t += 5) { settleOnce(); times.push(r.nowRef()); r.advance(5000); } // a settle every 5 seconds: a turn that ends the moment it starts
  assert.ok(sentTimes.length >= 3, 'it delivers when it may');
  for (let i = 1; i < sentTimes.length; i++) assert.ok(sentTimes[i] - sentTimes[i - 1] >= 30000, `injections are at least 30 s apart: ${sentTimes[i] - sentTimes[i - 1]} ms`);
  for (let i = 0; i < sentTimes.length; i++) assert.ok(sentTimes.filter(x => x >= sentTimes[i] && x < sentTimes[i] + 600000).length <= 3, 'no ten-minute window holds more than three injections');
  assert.ok(sentTimes.length <= 9, `thirty minutes: at most nine injections, got ${sentTimes.length}`);
  console.log(`pi_extension: loop test ok (${sentTimes.length} injections in 30 minutes of back-to-back settles against a Coral that always says deliver)`);
}
// 16. the settle's output is read when its stream CLOSES, not when the process exits (#11133, QA's P6): Node can emit a child's 'exit' before its last standard output data has been read, which dropped a notice
{
  const startSettle = () => { const r = rig(); r.advance(100000); r.fire('agent_start', {}); r.run(); r.fire('agent_settled', { aborted: false });
    for (let i = 0; i < 50 && !r.spawned.find(c => c.args[1] === 'agent_settled'); i++) { const t = r.timers.find(x => x.ms === 0 && !x.done); if (!t) break; t.done = true; t.fn(); }
    const child = r.spawned.find(c => c.args[1] === 'agent_settled'); assert.ok(child, 'the settle starts a hook program'); return { r, child }; };
  // exit first, then the data, then close: the order Node may deliver them in
  let { r, child } = startSettle();
  assert.ok(child.handlers.close, 'the settle\'s child is read until its output closes');
  if (child.handlers.exit) child.handlers.exit();
  r.run(false); assert.equal(r.sent.length, 0, 'an exit alone injects nothing: the output may not be read yet');
  child.stdout.handlers.data(good);
  child.handlers.close(); r.run(false);
  assert.equal(r.sent.length, 1, 'the notice that arrived after the exit event is injected');
  assert.equal(r.sent[0].msg.content, NOTICE);
  child.handlers.close(); r.run(false); assert.equal(r.sent.length, 1, 'a second close does not inject again');
  // data, then close, with no exit event at all
  ({ r, child } = startSettle()); child.stdout.handlers.data(good); child.handlers.close(); r.run(false);
  assert.equal(r.sent.length, 1, 'data then close injects once');
  // a hook that wrote its line and never closes: the 3 s kill ends it, and what it wrote is what is judged
  ({ r, child } = startSettle()); child.stdout.handlers.data(good);
  const kill = r.timers.filter(x => x.ms === 3000).pop(); assert.ok(kill, 'the kill timer is set'); kill.fn(); r.run(false);
  assert.equal(r.sent.length, 1, 'killed after its line: the line is injected once, the queue goes on');
  console.log('pi_extension: the settle output is read on close ok');
}
console.log('pi_extension: all ok');
