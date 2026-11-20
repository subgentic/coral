#!/usr/bin/env node
// Which browser (CDP) suites a change must run first (#19845): picked from the diff, not from a hand-kept list.
//
//   node fail_fast_suites.mjs <base> <head> [--only | --why | --json]
//
// It lists every *_browser suite (as of <head>) that
//   1. is itself added or changed in base..head,
//   2. names a changed static file (coral-go/pkg/frontend/static/**: its file name, e.g. "inbox_sidebar.js", "needs_rows_compact.css"),
//   3. names a class, id or data-attribute the diff adds or removes in a static file (a selector in a .css file, a quoted hyphenated name or
//      a data-* name in a .js/.html file), or
//   3b. measures what an id draws (getBoundingClientRect, offsetHeight...) while the diff changes a layout rule (padding, height, gap, grid...) under that id (#group-table-view),
//   4. is a census, pin or golden suite (these guard what no single file names).
// Default output is one suite name per line (the name run_cdp_suites.mjs --only takes, without ".test.js"); --only prints one
// "--only a,b,c" argument; --why adds the reason after each name; --json prints {suite: [reasons]}.
// It reads suites and diffs through git, so it works on any base..head without checking either out. It never runs a suite.
import { createRequire } from 'node:module';
const { execFileSync } = createRequire(import.meta.url)('./helpers/child_process.js'); // windowsHide on (child_process_hygiene)

const args = process.argv.slice(2), flags = new Set(args.filter(a => a.startsWith('--'))), [base, head] = args.filter(a => !a.startsWith('--'));
if (!base || !head) { console.error('usage: node fail_fast_suites.mjs <base> <head> [--only | --why | --json]'); process.exit(2); }
if (base.startsWith('-') || head.startsWith('-')) { console.error('base and head must be commits, not options (a value starting with "-" is refused)'); process.exit(2); }
const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...a) => execFileSync('git', a, { cwd: top, encoding: 'utf8', maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'pipe'] });
const STATIC = 'coral-go/pkg/frontend/static/', SUITES = 'tests/frontend/';
const GENERIC = new Set(['content-type', 'text-align', 'aria-label', 'aria-hidden', 'data-key', 'font-size', 'font-weight', 'line-height', 'flex-direction', 'align-items', 'justify-content', 'min-width', 'max-width', 'min-height', 'max-height', 'z-index', 'box-shadow', 'border-radius', 'text-decoration', 'white-space', 'overflow-wrap', 'pointer-events', 'user-select', 'x-coral-token', 'cache-control']);

let changed;
try { changed = git('diff', '--name-status', '--no-renames', `${base}..${head}`).split('\n').filter(Boolean).map(l => { const [s, ...f] = l.split('\t'); return { status: s, file: f.join('\t') }; }); }
catch (e) { console.error(`cannot diff ${base}..${head}: ${String(e.stderr || e.message).trim()}`); process.exit(2); }

const suiteFiles = git('ls-tree', '-r', '--name-only', head, '--', SUITES).split('\n').filter(f => /^tests\/frontend\/[^/]+_browser\.test\.js$/.test(f));
const text = Object.fromEntries(suiteFiles.map(f => [f, git('show', `${head}:${f}`)]));
const nameOf = f => f.slice(SUITES.length).replace(/\.test\.js$/, '');
const why = new Map(); // suite file -> reasons
const note = (f, reason) => { if (!why.has(f)) why.set(f, []); if (!why.get(f).includes(reason)) why.get(f).push(reason); };
const has = (body, needle) => body.includes(needle);

// 1. suites the diff itself touches
for (const c of changed) if (suiteFiles.includes(c.file)) note(c.file, 'changed in the diff');

// 2. suites that name a changed static file
const staticChanged = changed.filter(c => c.file.startsWith(STATIC) && !c.file.startsWith(STATIC + 'agent_docs/'));
for (const c of staticChanged) {
  const rel = c.file.slice(STATIC.length), base1 = rel.split('/').pop();
  for (const f of suiteFiles) if (has(text[f], rel) || new RegExp(`(^|[^\\w-])${base1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text[f])) note(f, `names ${rel}`);
}

// 3. suites that name a class, id or data-attribute the diff adds or removes
const tokensOf = (line, css) => {
  const out = new Set();
  if (css) {
    for (const m of line.matchAll(/\.([a-zA-Z_][\w-]*)/g)) if (/[a-z]/i.test(m[1]) && !/^\d/.test(m[1])) out.add(m[1]);
    for (const m of line.matchAll(/#([a-zA-Z_][\w-]*)/g)) out.add(m[1]);
    for (const m of line.matchAll(/\[(data-[\w-]+)/g)) out.add(m[1]);
  } else {
    for (const m of line.matchAll(/['"`]([^'"`\n]{1,200})['"`]/g)) for (const w of m[1].split(/\s+/)) if (/^[a-z][a-z0-9]*(-[a-z0-9_]+)+$/i.test(w) || /^[a-z]+(_[a-z0-9]+)+$/.test(w) && /^(?:[a-z]+_)?[a-z]+-/.test(m[1])) out.add(w);
    for (const m of line.matchAll(/\bdata-[\w-]+/g)) out.add(m[0]);
    for (const m of line.matchAll(/\bdataset\.([a-zA-Z]\w*)/g)) out.add('data-' + m[1].replace(/[A-Z]/g, c => '-' + c.toLowerCase()));
  }
  return out;
};
const LAYOUT = /\b(padding|margin|height|gap|grid|width|font-size|line-height|display|flex|position|top|left|right|bottom|inset)\b[^;}]*:/;
const MEASURES = /getBoundingClientRect|offsetHeight|offsetWidth|clientHeight|scrollWidth|scrollHeight/;
const layoutIds = new Map(); // id -> the stylesheet whose layout rule under it changed
const added = new Map(), removed = new Map(); // token -> a file it came from
for (const c of staticChanged) {
  if (!/\.(css|js|mjs|html)$/.test(c.file)) continue;
  let patch = '';
  try { patch = git('diff', '-U0', '--no-renames', `${base}..${head}`, '--', c.file); } catch { continue; }
  const css = c.file.endsWith('.css');
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const plus = line.startsWith('+'), minus = line.startsWith('-');
    if (!plus && !minus) continue;
    for (const t of tokensOf(line.slice(1), css)) (plus ? added : removed).set(t, c.file.slice(STATIC.length));
    if (css) { // a layout rule edited in place keeps its selector on both sides: the ids it sits under are the views it can move
      const body = line.slice(1), open = body.indexOf('{');
      if (open > 0 && LAYOUT.test(body.slice(open))) for (const m of body.slice(0, open).matchAll(/#([a-zA-Z_][\w-]*)/g)) layoutIds.set(m[1], c.file.slice(STATIC.length));
    }
  }
}
const moved = new Map(); // a token on one side only: added or removed; a token on both sides was only edited around
for (const [t, f] of added) if (!removed.has(t)) moved.set(t, f);
for (const [t, f] of removed) if (!added.has(t)) moved.set(t, f);
const COMMON = 40, common = [];
for (const [t, f] of moved) {
  if (GENERIC.has(t) || t.length < 4) continue;
  const re = new RegExp(`(^|[^\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`);
  const hit = suiteFiles.filter(f2 => re.test(text[f2]));
  if (hit.length > COMMON) { common.push(`${t} (${hit.length})`); continue; } // named by so many suites it says nothing about which ones a change can break
  for (const f2 of hit) note(f2, `${added.has(t) && !removed.has(t) ? 'adds' : 'removes'} "${t}" (${f})`);
}

// 3b. a layout rule under an id (#group-table-view) moved: every suite that names that id AND measures what is drawn (a height, a width, a position) can break, though none names the rule's class
for (const [id, f] of layoutIds) {
  const re = new RegExp(`(^|[^\\w-])${id}($|[^\\w-])`);
  for (const f2 of suiteFiles) if (re.test(text[f2]) && MEASURES.test(text[f2])) note(f2, `measures what #${id} draws; a layout rule under it changed (${f})`);
}

// 4. census, pin and golden suites
for (const f of suiteFiles) if (/census|pin|golden/.test(nameOf(f))) note(f, 'census / pin / golden');

const list = [...why.keys()].map(nameOf).sort();
if (flags.has('--json')) console.log(JSON.stringify(Object.fromEntries([...why].map(([f, r]) => [nameOf(f), r])), null, 1));
else if (flags.has('--only')) console.log('--only ' + list.map(n => n.replace(/_browser$/, '_browser')).join(','));
else if (flags.has('--why')) for (const n of list) console.log(`${n}  # ${why.get(SUITES + n + '.test.js').slice(0, 3).join('; ')}`);
else for (const n of list) console.log(n);
if (common.length) console.error(`not matched by name (more than ${COMMON} suites name each): ${common.join(', ')}`);
console.error(`${list.length} of ${suiteFiles.length} browser suites for ${changed.length} changed files (${staticChanged.length} static), ${moved.size} classes/ids/data-attributes added or removed`);
