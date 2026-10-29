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
// It does nothing at all when Coral did not launch Pi (no CORAL_SESSION_NAME), or when Coral's configuration is missing.

// Coral replaces the comment below with its configuration (a JSON object: hookBin, envNames) when it writes this file for a launch.
const CONFIG = /*__CORAL_PI_CONFIG__*/ null;

// The events registered: all notifications (Pi ignores what a handler returns for them).
const EVENTS = ['session_start', 'agent_start', 'tool_execution_start', 'tool_execution_end', 'agent_end', 'agent_settled', 'session_shutdown'];
const QUEUE_MAX = 64;      // events waiting for a spawn: the oldest is dropped past this
const TOOL_EVERY_MS = 250; // at most one tool event a quarter second: a tool call is two spawns otherwise, and Windows is slow to start a process
const CHILD_MS = 3000;     // a hook that has not ended by then is killed
const SAFE_NAME = /^[\x20-\x7e]{1,200}$/;

const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e12) ? v : undefined;
const name = (v, max) => (typeof v === 'string' && SAFE_NAME.test(v)) ? v.slice(0, max) : undefined;

function create(deps) {
  const { spawn, env, config, now, setTimer } = deps;
  const active = !!(config && typeof config.hookBin === 'string' && config.hookBin && Array.isArray(config.envNames) && env.CORAL_SESSION_NAME);
  const childEnv = () => { const out = {}; for (const k of config.envNames) { if (typeof k === 'string' && env[k] !== undefined) out[k] = env[k]; } return out; };
  const queue = []; let sending = false; let lastTool = -Infinity;
  const usage = { input: 0, output: 0, cost: 0, turns: 0, model: undefined, seen: false };

  function send(event, payload) {
    if (queue.length >= QUEUE_MAX) queue.shift();
    queue.push({ event, payload });
    if (!sending) { sending = true; setTimer(drain, 0); }
  }
  function drain() {
    const item = queue.shift();
    if (!item) { sending = false; return; }
    try {
      const child = spawn(config.hookBin, ['--pi', item.event], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: childEnv(), windowsHide: true, shell: false });
      child.on('error', () => {});
      if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(item.payload)); }
      const t = setTimer(() => { try { child.kill(); } catch (e) { /* gone already */ } }, CHILD_MS); if (t && t.unref) t.unref();
      child.unref();
    } catch (e) { /* never into Pi */ }
    setTimer(drain, 0);
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
  const handlers = {
    session_start: e => send('session_start', { reason: name(e && e.reason, 20) }),
    agent_start: () => send('agent_start', {}),
    tool_execution_start: e => tool('tool_execution_start', e, {}),
    tool_execution_end: e => tool('tool_execution_end', e, { is_error: !!(e && e.isError) }),
    agent_end: e => noteUsage(e),
    agent_settled: e => {
      const p = { aborted: !!(e && e.aborted) };
      if (usage.seen) { p.input_tokens = usage.input; p.output_tokens = usage.output; p.cost_usd = usage.cost; p.num_turns = usage.turns; if (usage.model) p.model = usage.model; }
      usage.input = usage.output = usage.cost = usage.turns = 0; usage.model = undefined; usage.seen = false;
      send('agent_settled', p);
    },
    session_shutdown: e => send('session_shutdown', { reason: name(e && e.reason, 20) }),
  };
  return function register(pi) {
    if (!active) return;
    for (const ev of EVENTS) {
      try { pi.on(ev, (event) => { try { handlers[ev](event); } catch (e) { /* never into Pi */ } return undefined; }); } catch (e) { /* an event this Pi does not know */ }
    }
  };
}

module.exports = create({ spawn: require('node:child_process').spawn, env: process.env, config: CONFIG, now: Date.now, setTimer: setTimeout });
module.exports.create = create;
module.exports.EVENTS = EVENTS;
