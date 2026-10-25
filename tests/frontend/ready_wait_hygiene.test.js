// A suite waits for the app's readiness hook through helpers/wait.js's coralReady(ev, step, ...args), never with ev(`window.__coralReady...`) itself (#352): that awaits the hook's promise inside
// the page with no time limit, so a hook that never resolves runs to the runner's 120 s with nothing saying which step it was, where coralReady fails at 10 s naming the part it waited for.
// The suites written before this rule are listed in fixtures/ready_wait_known.json with how many such waits each has; they are converted in batches. This check fails when a file has more than
// its listed number (a new open wait) and when it has fewer (the list must come down with the batch, so it never hides one). `node ready_wait_hygiene.test.js --write` rewrites the list.
//   node ready_wait_hygiene.test.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const OPEN = /\bev\(`window\.__coralReady(?:\.then\(|\.(?!parts\b)[A-Za-z]+\()/g; // the hook itself, or a step of it, awaited in the page; reading .parts is not a wait
const KNOWN = path.join(__dirname, 'fixtures', 'ready_wait_known.json');
const self = path.basename(__filename);

const files = [];
for (const dir of ['.', 'helpers']) for (const n of fs.readdirSync(path.join(__dirname, dir))) if (/\.(js|mjs)$/.test(n) && n !== self) files.push(dir === '.' ? n : `${dir}/${n}`);
const now = {};
for (const f of files) { const n = (fs.readFileSync(path.join(__dirname, f), 'utf8').match(OPEN) || []).length; if (n) now[f] = n; }

if (process.argv.includes('--write')) {
    fs.writeFileSync(KNOWN, JSON.stringify(Object.fromEntries(Object.entries(now).sort()), null, 1) + '\n');
    console.log(`ready_wait_hygiene: wrote ${Object.keys(now).length} files, ${Object.values(now).reduce((a, b) => a + b, 0)} open waits`);
    process.exit(0);
}
const known = JSON.parse(fs.readFileSync(KNOWN, 'utf8'));
const bad = [];
for (const [f, n] of Object.entries(now)) {
    if (n > (known[f] || 0)) bad.push(`${f}: ${n} open waits on window.__coralReady (listed: ${known[f] || 0}); use coralReady(ev, step, ...args) from helpers/wait.js`);
}
for (const [f, n] of Object.entries(known)) {
    if ((now[f] || 0) < n) bad.push(`${f}: ${now[f] || 0} open waits, the list says ${n}; bring fixtures/ready_wait_known.json down with the change (node ready_wait_hygiene.test.js --write)`);
}
if (bad.length) { console.error(`FAIL ready_wait_hygiene:\n  ${bad.join('\n  ')}`); process.exit(1); }
// the scan looks at what it should: the pattern finds a wait written the old way, and not the shared helper's own form
if (!OPEN.test('await ev(`window.__coralReady.then(() => true)`)') || (OPEN.lastIndex = 0, !OPEN.test("ev(`window.__coralReady.startup('liveList')`)")) || (OPEN.lastIndex = 0, OPEN.test('ev(`window.__coralReady.parts || null`)'))) {
    console.error('FAIL ready_wait_hygiene: the pattern does not match what it is for'); process.exit(1);
}
const left = Object.values(now).reduce((a, b) => a + b, 0);
console.log(`ready_wait_hygiene: ok (${left} listed open waits left in ${Object.keys(now).length} files; none new)`);
