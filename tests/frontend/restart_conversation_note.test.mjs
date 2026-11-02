// #11972 (QA on #11956): a restarted Hermes agent starts a new conversation and the restart's answer says so (conversation_note), shown as a toast. Every way to restart an agent must show it, so every way must end in the one
// function that posts the restart and reads its answer: this census fails when a second place posts to /restart, when a restart entry stops reaching that function, or when the note is read after the error branch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/pkg/frontend/static');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
const src = Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

// 1. only restart_flow.js posts a restart of one agent (/api/sessions/live/<name>/restart)
const posters = files.filter(f => /\/api\/sessions\/live\/[^`'"]*\/restart[`'"]/.test(src[f]));
assert.deepEqual(posters, ['restart_flow.js'], 'one place posts a restart, so one place shows what it says: ' + posters.join(', '));

// 2. inside it, the function that posts is runRestart, and every restart entry reaches it
const flow = src['restart_flow.js'];
const fnBody = name => { const i = flow.search(new RegExp(`(async )?function ${name}\\b`)); assert.ok(i >= 0, name + ' exists'); const j = flow.slice(i + 1).search(/\n(export )?(async )?function /); return flow.slice(i, j < 0 ? undefined : i + 1 + j); };
assert.match(fnBody('runRestart'), /\/restart`/, 'runRestart posts the restart');
assert.match(fnBody('confirmRestart'), /runRestart\(/, 'the restart dialog ends in runRestart');
assert.match(fnBody('restartSameSettings'), /runRestart\(/, 'the one-tap restart ends in runRestart');
assert.equal((flow.match(/\/restart`/g) || []).length, 1, 'one post in the flow');

// 3. the quick paths of the sidebar call those entries, not a restart of their own
const actions = src['agent_actions.js'];
assert.match(actions, /export async function restartDirect[\s\S]*?restartSession\(\)/, 'restartDirect opens the restart dialog');
assert.match(actions, /export async function restartSameDirect[\s\S]*?restartSameSettings\(\)/, 'restartSameDirect is the one-tap restart');

// 4. the note is shown, and before the error branch can end the function
const run = fnBody('runRestart');
const note = run.indexOf('result.conversation_note'), err = run.indexOf('if (result.error)');
assert.ok(note > 0 && /showToast\(result\.conversation_note\)/.test(run), 'runRestart shows conversation_note');
assert.ok(note < err, 'the note is read before the error branch');
console.log('restart_conversation_note: ok');
