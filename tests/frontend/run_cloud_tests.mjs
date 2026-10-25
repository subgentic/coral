// npm run test:cloud's steps, several at a time (#351): the same steps, read from package.json's test:cloud so the two lists cannot drift, each in its
// own process with its own temp folder (TMPDIR, TEMP and TMP), longest first from cloud_durations.json. A step's output is printed whole when it ends;
// the exit code is 1 when any step failed, and every failed step is listed at the end. test:cloud itself stays the serial run.
//   node run_cloud_tests.mjs [--jobs N] [--record]
// --record rewrites cloud_durations.json from this run's passing steps. Every step was checked for fixed ports, shared temp paths and ~/.coral before
// it ran in parallel: a step that needs any of them goes in SERIAL, and runs alone after the others.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from './helpers/child_process.js';
import { fileURLToPath } from 'node:url';
import { loadDurations, orderLongestFirst } from './suite_order.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DURATIONS = path.join(here, 'cloud_durations.json');
// Steps that must not share the machine with another step (a fixed port, a shared file or folder, ~/.coral): none today.
const SERIAL = new Set([]);

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const jobs = Math.max(1, Number(opt('--jobs')) || Math.min(8, Math.max(2, Math.floor(os.cpus().length / 2))));
const record = argv.includes('--record');

const steps = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).scripts['test:cloud'].split(' && ').map(s => s.trim());
const durations = loadDurations(DURATIONS);
const queue = orderLongestFirst(steps.filter(s => !SERIAL.has(s)), durations);
const serial = steps.filter(s => SERIAL.has(s));

function runStep(step) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coral-cloud-step-'));
    const t0 = Date.now();
    return new Promise(resolve => {
        const out = [];
        const child = spawn(step, { cwd: here, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp } });
        child.stdout.on('data', d => out.push(d));
        child.stderr.on('data', d => out.push(d));
        child.on('error', e => out.push(Buffer.from(String(e && e.stack || e) + '\n')));
        child.on('close', code => {
            try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* a process still holds it: the OS temp cleanup takes it */ }
            resolve({ step, code, secs: (Date.now() - t0) / 1000, out: Buffer.concat(out).toString('utf8') });
        });
    });
}

const results = [];
function report(r) {
    results.push(r);
    process.stdout.write(`\n> ${r.step}  (${r.secs.toFixed(1)} s${r.code ? `, exit ${r.code}` : ''})\n${r.out}`);
}

const t0 = Date.now();
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (next < queue.length) report(await runStep(queue[next++]));
}));
for (const s of serial) report(await runStep(s));

const failed = results.filter(r => r.code !== 0);
if (record) {
    const d = Object.fromEntries(steps.flatMap(s => { const r = results.find(x => x.step === s && x.code === 0); return r ? [[s, Math.round(r.secs * 10) / 10]] : []; }));
    fs.writeFileSync(DURATIONS, JSON.stringify(d, null, 1) + '\n');
}
console.log(`\ntest:cloud in parallel: ${results.length} steps, ${jobs} at a time, ${((Date.now() - t0) / 1000).toFixed(1)} s; ${failed.length ? `${failed.length} failed:\n  ${failed.map(r => r.step).join('\n  ')}` : 'all passed'}`);
process.exit(failed.length ? 1 : 0);
