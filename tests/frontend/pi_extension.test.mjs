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

function rig({ env, config = CONFIG, spawnThrows = false } = {}) {
  const spawned = [], timers = [], registered = {}; let nowMs = 1000;
  const spawn = (bin, args, opts) => {
    if (spawnThrows) throw new Error('spawn failed ' + CANARY);
    const child = { bin, args, opts, stdin: { data: '', on() {}, end(d) { this.data = d; } }, unrefd: false, killed: false, handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, unref() { this.unrefd = true; }, kill() { this.killed = true; } };
    spawned.push(child); return child;
  };
  const setTimer = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; };
  const e = ext.create({ spawn, env: env || { CORAL_SESSION_NAME: 'pi-1', CORAL_SESSION_TOKEN: 'tok', CORAL_URL: 'http://127.0.0.1:1', HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: CANARY, OPENAI_API_KEY: CANARY, AWS_SECRET_ACCESS_KEY: CANARY, GITHUB_TOKEN: CANARY }, config, now: () => nowMs, setTimer });
  const pi = { on(name, fn) { registered[name] = fn; } };
  e(pi);
  const run = (exitChildren = true) => { // run the scheduled drains until the queue is empty; each spawned hook then "exits", which lets the next start (the kill timers are left)
    for (let i = 0; i < 600; i++) {
      const t = timers.find(x => x.ms === 0 && !x.done);
      if (t) { t.done = true; t.fn(); continue; }
      const c = exitChildren ? spawned.find(x => !x.exited && x.handlers.exit) : null;
      if (!c) break; c.exited = true; c.handlers.exit();
    }
  };
  return { spawned, timers, registered, run, nowRef: () => nowMs, advance: ms => { nowMs += ms; }, fire: (name, ev) => registered[name](ev, {}) };
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
console.log('pi_extension: all ok');
