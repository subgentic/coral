'use strict';
// Coral's Pi extension (#11093, #11102): tells the dashboard what a Pi agent is doing. Coral writes this file into the agent's own temporary folder at launch and starts Pi with `-e <this file>`; it is never put
// in ~/.pi or in Pi's settings. It does NOT talk to Coral itself: it starts Coral's own hook program (`coral-hook-agentic-state --pi <event>`, the path written below by Coral) with a minimal JSON on its standard input.
//
// What it must never do (Security's conditions, design note v2):
//   - block, delay, change or cancel anything in Pi: it registers only NOTIFICATION events (EVENTS), never a gate (tool_call, tool_result, input, before_agent_start, context*, message_end, turn_end, ...), returns
//     undefined from every handler, never awaits (Pi awaits an async handler: a 3 s wait there holds the run), and swallows every error (a throw in some Pi handlers would block a tool);
//   - read or send a prompt, a tool's arguments or result, a message, a key or a file: the payload is the allow-list below (an event's name, a tool NAME, flags, the model and thinking-level NAMES, token counts);
//   - start anything but the one hook program (an argument array, no shell, the path a JSON string written by Coral), or pass it anything but the variables Coral listed (an allow-list, never Pi's whole environment,
//     so no provider key reaches a child);
//   - write a file, open a socket, or load other code.
// Board messages (slice 2): when a run settles, the hook program asks Coral whether the agent has board messages and writes ONE line of JSON, {"deliver":"<text>"}, to its standard output. The text is COMPOSED BY CORAL
// (a fixed opener, a count and a board name made fit): this file composes nothing. It checks the text once more (one key, printable ASCII, 300 characters, starts with the opener) and injects exactly it, or nothing, with
// pi.sendMessage as a follow-up that starts a turn (Pi gives it to the model as a user message, so the opener is what marks it as Coral's). Only for a run that settled normally (not an Escape), only while that run is
// still the latest, never while Pi is shutting down, and at most one injection every 30 s and three every 10 minutes (the server has its own bounds; this one does not trust it).
// It does nothing at all when Coral did not launch Pi (no CORAL_SESSION_NAME), or when Coral's configuration is missing.

// Coral replaces the comment below with its configuration (a JSON object: hookBin, envNames) when it writes this file for a launch.
const CONFIG = /*__CORAL_PI_CONFIG__*/ null;

// The events registered: all notifications (Pi ignores what a handler returns for them).
const EVENTS = ['session_start', 'agent_start', 'tool_execution_start', 'tool_execution_end', 'agent_end', 'agent_settled', 'session_shutdown'];
const QUEUE_MAX = 64;      // events waiting for a spawn: the oldest is dropped past this
const TOOL_EVERY_MS = 250; // at most one tool event a quarter second: a tool call is two spawns otherwise, and Windows is slow to start a process
const CHILD_MS = 3000;     // a hook that has not ended by then is killed
const SAFE_NAME = /^[\x20-\x7e]{1,200}$/;
const NOTICE_OPENER = '[Coral board] ';        // the fixed start of what Coral hands over (board.PiNoticeOpener)
const NOTICE_MAX = 300;                         // its longest, in characters
const NOTICE_TEXT = /^[\x20-\x7e]+$/;           // printable ASCII, one line
const STDOUT_MAX = 1024;                        // what is read of a hook's standard output
const INJECT_EVERY_MS = 30 * 1000;              // at most one injection this often
const INJECT_WINDOW_MS = 10 * 60 * 1000, INJECT_PER_WINDOW = 3; // and three in this window

const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e12) ? v : undefined;
const name = (v, max) => (typeof v === 'string' && SAFE_NAME.test(v)) ? v.slice(0, max) : undefined;

function create(deps) {
  const { spawn, env, config, now, setTimer } = deps;
  const active = !!(config && typeof config.hookBin === 'string' && config.hookBin && Array.isArray(config.envNames) && env.CORAL_SESSION_NAME);
  const childEnv = () => { const out = {}; for (const k of config.envNames) { if (typeof k === 'string' && env[k] !== undefined) out[k] = env[k]; } return out; };
  const queue = []; let sending = false; let lastTool = -Infinity;
  const usage = { input: 0, output: 0, cost: 0, turns: 0, model: undefined, seen: false };
  let running = false; // an agent run has started and not settled
  let runs = 0;        // how many runs have started: a settle's delivery is for the latest run only
  let closing = false; // Pi is shutting down
  let piRef = null;
  const injected = []; // when each injection was made

  function send(event, payload, more) {
    if (queue.length >= QUEUE_MAX) queue.shift();
    queue.push({ event, payload, ...(more || {}) });
    if (!sending) { sending = true; setTimer(drain, 0); }
  }
  // One hook program at a time, in the order the events happened: independent processes would race (a late "agent started" after "agent settled" would leave the agent Working). Nothing waits for it on Pi's path:
  // the next one starts when the last has ended, and a hook that has not ended by CHILD_MS is killed and the queue goes on. When Pi is shutting down the process ends with its extension, so whatever is still queued
  // is dealt with in ONE hook process (shutdownNow): whatever Stop had not been sent, with its usage, and the session's end, posted by that one program in that order.
  function start(item, then) {
    let finished = false;
    let out = ''; let outBytes = 0;
    const next = () => { if (!finished) { finished = true; try { if (item.collect) deliver(item, out); } catch (e) { /* never into Pi */ } if (then) then(); } };
    try {
      const child = spawn(config.hookBin, ['--pi', item.event, '--hooks-rev', String(config.rev || 1)], { detached: true, stdio: ['pipe', item.collect ? 'pipe' : 'ignore', 'ignore'], env: childEnv(), windowsHide: true, shell: false });
      // A child whose output is read ends at 'close' (its streams are done, so the last data has been read): Node can emit 'exit' before the final stdout data, which dropped a notice (#11133, QA's P6). The others end at 'exit'.
      child.on('error', next); child.on(item.collect ? 'close' : 'exit', next);
      if (item.collect && child.stdout) { child.stdout.on('error', () => {}); child.stdout.on('data', c => { if (outBytes < STDOUT_MAX) { out += String(c).slice(0, STDOUT_MAX - outBytes); outBytes = out.length; } else { out = ''; outBytes = STDOUT_MAX + 1; } }); }
      if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(item.payload)); }
      const t = setTimer(() => { try { child.kill(); } catch (e) { /* gone already */ } next(); }, CHILD_MS); if (t && t.unref) t.unref();
      child.unref();
    } catch (e) { /* never into Pi */ next(); }
  }
  // What a hook program wrote for a settled run: injected only when it is exactly Coral's notice and every guard holds.
  function deliver(item, raw) {
    if (!piRef || closing || item.aborted || item.run !== runs) return; // an Escape, a newer run, or the end: nothing is injected
    if (!raw || raw.length > STDOUT_MAX) return;
    let parsed; try { parsed = JSON.parse(raw); } catch (e) { return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const keys = Object.keys(parsed);
    const text = parsed.deliver;
    if (keys.length !== 1 || keys[0] !== 'deliver' || typeof text !== 'string') return;
    if (text.length > NOTICE_MAX || !text.startsWith(NOTICE_OPENER) || !NOTICE_TEXT.test(text)) return;
    const t = now();
    while (injected.length && t - injected[0] >= INJECT_WINDOW_MS) injected.shift();
    if (injected.length >= INJECT_PER_WINDOW || (injected.length && t - injected[injected.length - 1] < INJECT_EVERY_MS)) return;
    injected.push(t);
    const r = piRef.sendMessage({ customType: 'coral-board', content: text, display: true }, { triggerTurn: true, deliverAs: 'followUp' });
    if (r && typeof r.catch === 'function') r.catch(() => {});
  }
  function drain() {
    const item = queue.shift();
    if (!item) { sending = false; return; }
    start(item, () => setTimer(drain, 0));
  }
  const tool = (event, e, extra) => {
    const t = now(); if (t - lastTool < TOOL_EVERY_MS) return; lastTool = t;
    const toolName = name(e && e.toolName, 60); if (!toolName) return;
    const id = name(e && e.toolCallId, 128);
    send(event, { tool_name: toolName, ...(id ? { tool_use_id: id } : {}), ...extra });
  };
  const noteUsage = e => {
    for (const m of (e && Array.isArray(e.messages)) ? e.messages : []) {
      if (!m || m.role !== 'assistant') continue;
      usage.seen = true; usage.turns += 1;
      const u = m.usage || {};
      usage.input += num(u.input) || 0; usage.output += num(u.output) || 0;
      usage.cost += num(typeof u.cost === 'object' && u.cost ? u.cost.total : u.cost) || 0;
      usage.model = name(m.model, 80) || usage.model;
    }
  };
  const settledPayload = e => {
    const p = { aborted: !!(e && e.aborted) };
    if (usage.seen) { p.input_tokens = usage.input; p.output_tokens = usage.output; p.cost_usd = usage.cost; p.num_turns = usage.turns; if (usage.model) p.model = usage.model; }
    usage.input = usage.output = usage.cost = usage.turns = 0; usage.model = undefined; usage.seen = false;
    return p;
  };
  // The process ends with the extension: ONE event carries the last of it (a Stop that was not sent yet, with its usage) and the session's end; the program posts Stop, then SessionEnd, in this order, in one process.
  // Everything still queued is superseded by it (display only), except a queued agent_settled, whose payload it takes over.
  const shutdownNow = e => {
    closing = true;
    let settled = null;
    for (const q of queue) if (q.event === 'agent_settled') settled = q.payload;
    queue.length = 0;
    const p = { reason: name(e && e.reason, 20) };
    if (settled || running || usage.seen) {
      p.stop = true;
      Object.assign(p, settled || settledPayload(null));
    }
    running = false;
    start({ event: 'session_shutdown', payload: p }, null);
  };
  const handlers = {
    session_start: e => send('session_start', { reason: name(e && e.reason, 20) }),
    agent_start: () => { running = true; runs += 1; send('agent_start', {}); },
    tool_execution_start: e => tool('tool_execution_start', e, {}),
    tool_execution_end: e => tool('tool_execution_end', e, { is_error: !!(e && e.isError) }),
    agent_end: e => noteUsage(e),
    agent_settled: e => { running = false; const p = settledPayload(e); send('agent_settled', p, { collect: true, run: runs, aborted: p.aborted }); },
    session_shutdown: e => shutdownNow(e),
  };
  return function register(pi) {
    if (!active) return;
    piRef = pi;
    for (const ev of EVENTS) {
      try { pi.on(ev, (event) => { try { handlers[ev](event); } catch (e) { /* never into Pi */ } return undefined; }); } catch (e) { /* an event this Pi does not know */ }
    }
  };
}

module.exports = create({ spawn: require('node:child_process').spawn, env: process.env, config: CONFIG, now: Date.now, setTimer: setTimeout });
module.exports.create = create;
module.exports.EVENTS = EVENTS;
