// A '//' comment that has code after it on the same line is a slip: the code is part of the comment and never runs (#9874; the #9861 setAttribute calls, twice in test strings before).
// Flags a line of the dashboard's JS whose comment text holds a ';' and then a call or an assignment: "// note ... group.setAttribute('role', 'group');". Real prose that looks like that is in the baseline
// (fixtures/comment_swallow_baseline.json), which only goes down.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../../coral-go/pkg/frontend/static');

/** The index of a '//' that starts a comment in this line (outside a string, a template's text or a regex literal's slashes), or -1. `state` carries a template or block comment across lines. */
export function commentStart(line, state) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i], n = line[i + 1];
    if (state.block) { if (c === '*' && n === '/') { state.block = false; i++; } continue; }
    if (state.template && !quote) { // inside a template literal's text
      if (c === '\\') { i++; continue; }
      if (c === '`') state.template = false;
      continue;
    }
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '`') { state.template = true; continue; }
    if (c === '/' && n === '*') { state.block = true; i++; continue; }
    if (c === '/' && n === '/') return i;
    if (c === '/') { // a regex literal: skip to its closing slash when it follows an operator or an opening bracket
      const prev = line.slice(0, i).trimEnd().slice(-1);
      if (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev)) { let j = i + 1, cls = false; for (; j < line.length; j++) { const d = line[j]; if (d === '\\') { j++; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; } if (j < line.length) i = j; }
    }
  }
  return -1;
}

const CODE_AFTER = /;\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])*\s*(?:\(|=(?!=)|\+=|-=)/;

export function findings(text) {
  const out = [], state = { block: false, template: false };
  text.split('\n').forEach((line, idx) => {
    const at = commentStart(line, state);
    if (at < 0) return;
    if (line.slice(0, at).trim() === '') return; // a comment on its own line has no code before it to be the slip's victim: the slip is code, a comment, then more code
    const comment = line.slice(at + 2);
    if (/^\s*(https?:|eslint|@ts-|sleep-ok|timeout-ok|timer-ok)/.test(comment)) return;
    if (CODE_AFTER.test(comment)) out.push({ line: idx + 1, text: line.trim().slice(0, 140) });
  });
  return out;
}

// The shape of the slip is found, prose and ordinary trailing comments are not.
const slip = "    const group = el('div', 'x'); // more than five pills need room (#9861) group.setAttribute('role', 'group'); group.setAttribute('aria-label', p.label);";
assert.equal(findings(slip).length, 1, 'the #9861 slip is flagged');
assert.equal(findings("    const a = 1; // a note, then another note\n    foo(); // ok; fine\n    x = 'a // b; c.d(1)'; /* y */\n    const re = /\\/\\//; // the regexp\n").length, 0, 'a plain trailing comment, a string holding //, a regexp are not');
assert.equal(findings("    const s = `a // b; c.d()`;\n    run(); // sleep-ok: x; y.z()\n").length, 0, 'a template text and a marked comment are not');

const found = {};
const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/vendor|node_modules|agent_docs/.test(e.name)) walk(p); } else if (e.name.endsWith('.js')) { const f = findings(fs.readFileSync(p, 'utf8')); if (f.length) found[path.relative(root, p)] = f.map(x => x.line + ': ' + x.text); } } };
walk(root);

const baselinePath = path.join(here, 'fixtures/comment_swallow_baseline.json');
if (process.env.CORAL_UPDATE_COMMENT_LINT === '1') fs.writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(Object.entries(found).map(([f, ls]) => [f, ls.map(l => l.slice(l.indexOf(':') + 2))])), null, 2) + '\n');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const problems = [];
for (const [f, ls] of Object.entries(found)) for (const l of ls) { const text = l.slice(l.indexOf(':') + 2); if (!(baseline[f] || []).includes(text)) problems.push(`${f}:${l.split(':')[0]}: code after a // comment is part of the comment and never runs: ${text}`); }
for (const [f, ls] of Object.entries(baseline)) for (const t of ls) if (!(found[f] || []).some(l => l.slice(l.indexOf(':') + 2) === t)) problems.push(`${f}: a baselined line is gone: take it out of fixtures/comment_swallow_baseline.json (CORAL_UPDATE_COMMENT_LINT=1 rewrites it): ${t.slice(0, 80)}`);
assert.deepEqual(problems, [], problems.join('\n'));
console.log(`comment_swallow_lint: ok (a '//' comment holding ';' and then a call or an assignment: ${Object.keys(found).length} files with prose that looks like it, all in the baseline; it only goes down)`);
