// #11107 slice 1b acceptance (Security's SHOULD 3): the END-TO-END canary. The real Pi extension (as Coral writes it), a stand-in model and a stand-in Coral, and a secret in the prompt, in a tool result, in the provider
// variables of Pi's environment and in Pi's own files: the secret appears in no environment a hook program gets, no payload on its standard input, no request to Coral, and no file the hook programs leave behind.
// Needs `pi` (Pi 1.4.0 or later), `go` and `node` on this machine; it runs nothing of yours: a throwaway folder, a throwaway key, 127.0.0.1 only, never ~/.pi (PI_CODING_AGENT_DIR), and is skipped when Pi is not installed.
//   node tests/pi/pi_canary_e2e.mjs        (from the repository root)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PI = process.env.PI_BIN || path.join(os.homedir(), '.pi/agent/bin/pi');
if (!fs.existsSync(PI)) { console.log('pi_canary_e2e: SKIPPED (no pi at ' + PI + ')'); process.exit(0); }
const CANARY = 'CANARY-SECRET-7F3A';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-canary.'));
const dirs = Object.fromEntries(['agent', 'sessions', 'work', 'tools', 'data', 'dump'].map(d => [d, fs.mkdtempSync(path.join(tmp, d + '.'))]));
const cleanups = [];
const done = code => { for (const c of cleanups) try { c(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };

// the real hook program, and a recording one that dumps what it is given
const real = path.join(dirs.tools, 'coral-hook-agentic-state');
let r = spawnSync('go', ['build', '-o', real, './cmd/coral-hook-agentic-state'], { cwd: path.join(root, 'coral-go'), encoding: 'utf8' });
assert.equal(r.status, 0, 'go build: ' + r.stderr);
const recorder = path.join(dirs.tools, 'recorder.sh');
fs.writeFileSync(recorder, `#!/bin/sh\nn=$(date +%s%N)\nenv > "${dirs.dump}/env.$n"\necho "$@" > "${dirs.dump}/args.$n"\ncat > "${dirs.dump}/stdin.$n"\n`, { mode: 0o755 });

// the extension as Coral writes it: the embedded source with the configuration written in (the Go launch test pins that this is the same)
const goSrc = fs.readFileSync(path.join(root, 'coral-go/internal/agent/pi_extension.go'), 'utf8');
const envNames = [...goSrc.match(/var piHookEnvNames = \[\]string\{([^}]*)\}/)[1].matchAll(/"([A-Z_]+)"/g)].map(m => m[1]); // the list Coral gives the extension, read from its source
assert.ok(envNames.includes('CORAL_SESSION_TOKEN') && envNames.length > 10, 'the allow-list was read');
const src = fs.readFileSync(path.join(root, 'coral-go/internal/agent/pi_extension/coral_pi.js'), 'utf8');
const ext = bin => { const p = path.join(dirs.agent, 'ext_' + path.basename(bin) + '.js'); fs.writeFileSync(p, src.replace('/*__CORAL_PI_CONFIG__*/ null', JSON.stringify({ hookBin: bin, envNames, rev: 1 })), { mode: 0o600 }); return p; };

// a stand-in Coral (records whole request bodies) and a stand-in model (calls bash once, then answers)
const coralBodies = []; const modelSeen = [];
const serve = (handler) => new Promise(res => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => { cleanups.push(() => s.close()); res(s.address().port); }); });
const coralPort = await serve((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { coralBodies.push(q.method + ' ' + q.url + ' ' + b); s.writeHead(200, { 'content-type': 'application/json' }); s.end('{}'); }); });
const modelPort = await serve((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => setTimeout(() => { // a model that takes its time, as a real one does: the extension's events are then spread out, not squeezed into one instant
  let j = {}; try { j = JSON.parse(b); } catch {}
  const msgs = j.messages || []; modelSeen.push({ roles: msgs.map(m => m.role), canaryInToolResult: msgs.filter(m => m.role === 'tool').some(m => JSON.stringify(m).includes(CANARY)) });
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish, usage) => s.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fake-chat', choices: [{ index: 0, delta, finish_reason: finish || null }], ...(usage ? { usage } : {}) }) + '\n\n');
  if (!msgs.some(m => m.role === 'tool')) { chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 0.5; cat canary.txt' }) } }] }); chunk({}, 'tool_calls', { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }); }
  else { chunk({ role: 'assistant', content: 'done' }); chunk({}, 'stop', { prompt_tokens: 22, completion_tokens: 3, total_tokens: 25 }); }
  s.write('data: [DONE]\n\n'); s.end();
}, 700)); });
fs.writeFileSync(path.join(dirs.work, 'canary.txt'), CANARY + ' in a file a tool reads\n');
const provider = path.join(dirs.agent, 'provider.js');
fs.writeFileSync(provider, `module.exports = pi => pi.registerProvider('fake', { name: 'Fake', baseUrl: 'http://127.0.0.1:${modelPort}/v1', apiKey: 'dummy-key-not-real', api: 'openai-completions', models: [{ type: 'chat', id: 'fake-chat', name: 'Fake Chat', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 1000 }] });\n`);

// async, not spawnSync: the stand-in servers live in this process and must keep answering while Pi runs
function runPi(extFile) {
  const env = { PATH: process.env.PATH, HOME: dirs.data, CORAL_SESSION_NAME: 'pi-11111111-2222-3333-4444-555555555555', CORAL_URL: `http://127.0.0.1:${coralPort}`, CORAL_PORT: String(coralPort), CORAL_HOST: '127.0.0.1', CORAL_DATA_DIR: dirs.data, CORAL_SESSION_TOKEN: 'session-token-not-a-secret',
    ANTHROPIC_API_KEY: CANARY, OPENAI_API_KEY: CANARY, AWS_SECRET_ACCESS_KEY: CANARY, AWS_ACCESS_KEY_ID: CANARY, GITHUB_TOKEN: CANARY, GEMINI_API_KEY: CANARY, PI_CODING_AGENT_DIR: dirs.agent, PI_OFFLINE: '1' };
  return new Promise(resolve => {
    const child = spawn(PI, ['--offline', '--session-dir', dirs.sessions, '-e', provider, '-e', extFile, '--provider', 'fake', '--model', 'fake-chat', '-p', `${CANARY} in the prompt: show the file`], { cwd: dirs.work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const t = setTimeout(() => child.kill(), 90000);
    child.on('exit', status => { clearTimeout(t); resolve({ status, stdout, stderr }); });
  });
}
const files = d => fs.readdirSync(d).map(f => path.join(d, f));
const contains = (list) => list.filter(f => fs.statSync(f).isFile() && fs.readFileSync(f, 'utf8').includes(CANARY));

// run A: a recording stand-in for the hook program: what a hook program is GIVEN (environment, arguments, standard input)
const a = await runPi(ext(recorder));
assert.ok(a.status === 0 || a.status === 1, 'pi ran: status ' + a.status + ' ' + String(a.error) + ' ' + (a.stderr || '').slice(0, 300) + ' ' + (a.stdout || '').slice(0, 300));
await new Promise(r => setTimeout(r, 1500));
const dumped = files(dirs.dump);
const events = files(dirs.dump).filter(f => path.basename(f).startsWith('args.')).map(f => fs.readFileSync(f, 'utf8').split(' ')[1]).sort();
assert.deepEqual(events, ['agent_start', 'session_shutdown', 'session_start', 'tool_execution_end', 'tool_execution_start'], 'the extension started the hook program for the start, the run, the tool (its start and its end: the tool runs more than a quarter second) and the end (the settle rides in the shutdown event): ' + events.join(', '));
assert.ok(modelSeen.some(m => m.canaryInToolResult), 'the stand-in model did receive the tool result with the canary (the test is real: the secret was in Pi\'s hands)');
assert.deepEqual(contains(dumped), [], 'no canary in any environment, argument or payload a hook program was given');
const envFiles = dumped.filter(f => path.basename(f).startsWith('env.'));
for (const f of envFiles) { const names = fs.readFileSync(f, 'utf8').split('\n').map(l => l.split('=')[0]).filter(Boolean); for (const n of names) assert.ok(envNames.includes(n) || ['PWD', 'SHLVL', '_', 'OLDPWD'].includes(n), `a variable that is not on the allow-list reached a hook: ${n}`); }
for (const f of dumped.filter(f => path.basename(f).startsWith('stdin.'))) { const p = JSON.parse(fs.readFileSync(f, 'utf8')); for (const k of Object.keys(p)) assert.ok(['reason', 'stop', 'tool_name', 'tool_use_id', 'is_error', 'aborted', 'model', 'input_tokens', 'output_tokens', 'cost_usd', 'num_turns'].includes(k), `payload key outside the allow-list: ${k}`); }
console.log(`pi_canary_e2e: run A ok: ${envFiles.length} hook processes given no secret, no extra variable, only allow-listed payload keys`);

// run B: the real hook program against the stand-in Coral
coralBodies.length = 0;
const b = await runPi(ext(real));
assert.ok(b.status === 0 || b.status === 1, 'pi ran: ' + b.stderr.slice(0, 200));
await new Promise(r => setTimeout(r, 2000));
assert.ok(coralBodies.length >= 5, `the real hook program posted its events to the stand-in Coral (${coralBodies.length})`);
assert.deepEqual(coralBodies.filter(x => x.includes(CANARY)), [], 'no canary in any request to Coral');
const left = []; const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else left.push(p); } };
walk(dirs.data);
const withCanary = contains(left).filter(f => !f.includes(dirs.sessions));
assert.deepEqual(withCanary, [], 'no canary in any file the hook programs (or Pi) left in the data folder: ' + withCanary.join(', '));
console.log(`pi_canary_e2e: run B ok: ${coralBodies.length} requests to Coral and ${left.length} files left behind hold no secret`);
console.log('pi_canary_e2e: all ok');
done(0);
