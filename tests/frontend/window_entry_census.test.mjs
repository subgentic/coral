// A browser suite reaches the app the way the app is reached (#9807, the lesson of #9794): a function that is also a window.* entry point (the one a button, a menu or a link calls) is called as window.<name>(),
// not as the module's own function, because a wrapper between the two (mobile.js's selectLiveSession once dropped the options Open chat and a click pass) is invisible to a test that skips it.
// The baseline lists the files that still import a module's function on purpose (an oracle of old against new, a test of the module's own ordering, a stand-in); it only goes down.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const actions = fs.readFileSync(path.join(here, '../../coral-go/pkg/frontend/static/app_actions.js'), 'utf8');

// The names app_actions puts on window: the identifiers inside its Object.assign(window, { ... }) blocks.
const names = new Set();
for (const m of actions.matchAll(/Object\.assign\(window, \{([\s\S]*?)\n\}\);/g)) {
  for (const id of m[1].replace(/\/\/.*$/gm, '').matchAll(/\b([a-z][A-Za-z0-9]{5,})\b(?=\s*[,:}\n])/g)) names.add(id[1]);
}
assert.ok(names.has('selectLiveSession') && names.has('applySettings') && names.size > 60, 'the window entry points were read: ' + names.size);

const found = {};
for (const f of fs.readdirSync(here).filter(x => /\.(test\.js|test\.mjs)$|^text200_scenes\.js$/.test(x))) {
  const t = fs.readFileSync(path.join(here, f), 'utf8');
  const hits = new Set();
  // import(...).then(m => m.fn(  and  const m = await import(...); ... m.fn(   and   const { fn } = await import(...)
  for (const m of t.matchAll(/import\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\(?\s*\1\.(\w+)\(/g)) if (names.has(m[2])) hits.add(m[2]);
  for (const m of t.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await import\([^()]*(?:\([^()]*\)[^()]*)*\)/g)) {
    for (const u of t.slice(m.index + m[0].length, m.index + m[0].length + 1500).matchAll(new RegExp('\\b' + m[1] + '\\.(\\w+)\\(', 'g'))) if (names.has(u[1])) hits.add(u[1]);
  }
  for (const m of t.matchAll(/const\s*\{([^}]*)\}\s*=\s*await import\(/g)) for (const n of m[1].split(',').map(x => x.trim().split(':')[0])) if (names.has(n)) hits.add(n);
  if (hits.size) found[f] = [...hits].sort();
}

const baselinePath = path.join(here, 'fixtures/window_entry_baseline.json');
const update = process.env.CORAL_UPDATE_WINDOW_ENTRY === '1';
if (update) fs.writeFileSync(baselinePath, JSON.stringify(found, null, 2) + '\n');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const problems = [];
for (const [f, fns] of Object.entries(found)) {
  const allowed = new Set(baseline[f] || []);
  for (const fn of fns) if (!allowed.has(fn)) problems.push(`${f} calls the module's ${fn}(); call window.${fn}() instead (the entry point a person's click reaches). A deliberate exception goes in fixtures/window_entry_baseline.json.`);
}
for (const [f, fns] of Object.entries(baseline)) for (const fn of fns) if (!(found[f] || []).includes(fn)) problems.push(`${f} no longer calls the module's ${fn}(): take it out of fixtures/window_entry_baseline.json (CORAL_UPDATE_WINDOW_ENTRY=1 rewrites it)`);
assert.deepEqual(problems, [], problems.join('\n'));
console.log(`window_entry_census: ok (${names.size} window entry points; ${Object.keys(baseline).length} suites still call a module's function on purpose, listed in the baseline; it only goes down)`);

// The census sees what it should: a fake suite that imports the module's function is a finding.
const sample = "await ev(`import(S + 'sessions.js').then(m => m.selectLiveSession('a'))`)";
assert.ok(/import\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\(?\s*\1\.(\w+)\(/.test(sample), 'the pattern sees a module call');
