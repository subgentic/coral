// #11107 slice 2 acceptance: board message delivery end to end, and the loop test with a real Pi. The real extension (as Coral writes it) and the real hook program under Pi 1.4.0, a stand-in model and a stand-in Coral
// whose turn-end route ALWAYS says "hand over" with a notice: without the extension's own bounds, every settle would inject the notice again and the agent would never stop. It asserts the stand-in model received the
// notice exactly once, as a user-role message that starts with Coral's fixed opener, that Coral was asked at least twice (so the loop was possible), and that nothing but the notice text was injected.
// Needs `pi`, `go` and `node`; skipped without Pi; a throwaway folder, 127.0.0.1 only, never ~/.pi.   node tests/pi/pi_delivery_e2e.mjs   (from the repository root)
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
const NOTICE = '[Coral board] 2 new messages on team-a. Run coral-board read to read them, then carry on.';
const coralPort = await serve((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { coralBodies.push(q.method + ' ' + q.url + ' ' + b); s.writeHead(200, { 'content-type': 'application/json' }); s.end(q.url.endsWith('/turn-end') ? JSON.stringify({ handoff: true, reason: 'New board messages', context: NOTICE }) : '{}'); }); });
const modelPort = await serve((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => setTimeout(() => { // a model that takes its time, as a real one does: the extension's events are then spread out, not squeezed into one instant
  let j = {}; try { j = JSON.parse(b); } catch {}
  const msgs = j.messages || []; modelSeen.push({ roles: msgs.map(m => m.role), notices: msgs.filter(m => m.role === 'user' && JSON.stringify(m.content).includes('[Coral board]')).map(m => typeof m.content === 'string' ? m.content : m.content.map(p => p.text || '').join('')), noticeAnywhere: (b.match(/\[Coral board\]/g) || []).length });
  s.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish, usage) => s.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fake-chat', choices: [{ index: 0, delta, finish_reason: finish || null }], ...(usage ? { usage } : {}) }) + '\n\n');
  if (!msgs.some(m => m.role === 'tool')) { chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 0.5; cat canary.txt' }) } }] }); chunk({}, 'tool_calls', { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }); }
  else { chunk({ role: 'assistant', content: 'done' }); chunk({}, 'stop', { prompt_tokens: 22, completion_tokens: 3, total_tokens: 25 }); }
  s.write('data: [DONE]\n\n'); s.end();
}, 700)); });
fs.writeFileSync(path.join(dirs.work, 'canary.txt'), CANARY + ' in a file a tool reads\n');
const provider = path.join(dirs.agent, 'provider.js');
fs.writeFileSync(provider, `module.exports = pi => pi.registerProvider('fake', { name: 'Fake', baseUrl: 'http://127.0.0.1:${modelPort}/v1', apiKey: 'dummy-key-not-real', api: 'openai-completions', models: [{ type: 'chat', id: 'fake-chat', name: 'Fake Chat', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 1000 }] });\n`);

// A real session: Pi in RPC mode, kept alive after the run settles (as an interactive one is), so the extension's follow-up has a process to start a turn in. async, not spawnSync: the stand-in servers live in this process.
function runPi(extFile) {
  const env = { PATH: process.env.PATH, HOME: dirs.data, CORAL_SESSION_NAME: 'pi-11111111-2222-3333-4444-555555555555', CORAL_URL: `http://127.0.0.1:${coralPort}`, CORAL_PORT: String(coralPort), CORAL_HOST: '127.0.0.1', CORAL_DATA_DIR: dirs.data, CORAL_SESSION_TOKEN: 'session-token-not-a-secret',
    ANTHROPIC_API_KEY: CANARY, PI_CODING_AGENT_DIR: dirs.agent, PI_OFFLINE: '1' };
  return new Promise(resolve => {
    const child = spawn(PI, ['--offline', '--mode', 'rpc', '--session-dir', dirs.sessions, '-e', provider, '-e', extFile, '--provider', 'fake', '--model', 'fake-chat'], { cwd: dirs.work, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', ends = 0;
    child.stdout.on('data', c => { stdout += c; ends = (stdout.match(/"type":"agent_end"/g) || []).length; });
    child.stderr.on('data', c => stderr += c);
    child.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: 'show the file' }) + '\n');
    const t0 = Date.now();
    const poll = setInterval(() => { if (ends >= 2 || Date.now() - t0 > 20000) { clearInterval(poll); setTimeout(() => child.stdin.end(), 6000); } }, 200); // after the notice's turn (or 20 s): six more seconds for anything the bound should have stopped, then EOF
    const kill = setTimeout(() => child.kill(), 60000);
    child.on('exit', status => { clearTimeout(kill); clearInterval(poll); resolve({ status, stdout, stderr, ends }); });
  });
}
const files = d => fs.readdirSync(d).map(f => path.join(d, f));
const contains = (list) => list.filter(f => fs.statSync(f).isFile() && fs.readFileSync(f, 'utf8').includes(CANARY));

// one run with the real hook program: the stand-in Coral always hands over
coralBodies.length = 0;
const run = await runPi(ext(real));
assert.ok(run.status === 0 || run.status === 1 || run.status === null, 'pi ran: status ' + run.status + ' ' + (run.stderr || '').slice(0, 300));
await new Promise(r => setTimeout(r, 1500));
const asked = coralBodies.filter(x => x.includes('/turn-end')).length;
assert.ok(asked >= 2, `the stand-in Coral was asked at every settle, so a loop was possible: asked ${asked} times`);
const last = modelSeen[modelSeen.length - 1];
assert.ok(last, 'the stand-in model was called');
const everyNotice = modelSeen.flatMap(m => m.notices);
assert.ok(everyNotice.length >= 1, 'the notice reached the model: ' + JSON.stringify(modelSeen.map(m => m.roles)));
const finalNotices = last.notices;
assert.equal(finalNotices.length, 1, `the model's last request holds the notice exactly once (the bound held; without it every settle injects again): ${finalNotices.length}`);
assert.equal(finalNotices[0], NOTICE, 'and it is exactly the text Coral composed, nothing added or changed');
assert.ok(modelSeen.some(m => m.roles.includes('user') && m.roles.lastIndexOf('user') > m.roles.indexOf('assistant')), 'it arrived as a user-role message after the agent had answered (a follow-up that started a turn)');
assert.ok(modelSeen.length <= 5, `Pi made at most the prompt's two requests and the notice's turn(s): ${modelSeen.length}`);
console.log(`pi_delivery_e2e: ok: Coral asked ${asked} times, the model saw the notice once and exactly as composed, ${modelSeen.length} model requests in all`);
done(0);
