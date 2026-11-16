#!/usr/bin/env node
// Which browser suites can a change break? (#17652) Two reviews in an hour bounced for the same reason: a diff reworded text and a suite the author never ran still asserted the old words.
//   node tests/frontend/affected_suites.mjs <base> [<head>]      (head defaults to the working tree's HEAD plus uncommitted changes)
// A git diff plus a grep, no parser. From each changed non-test file it takes what the diff REMOVED and did not write back: quoted strings, class names, ids, aria-labels and the plain
// words between tags. Every suite under tests/frontend that contains one of those, verbatim, is listed with the token that matched. Suites that import a changed test helper (helpers/*,
// *_harness.js) are listed too. It prints the command to run them. Too short or too common a token is skipped; a longer reword is what makes the list useful, so it can over-list a
// little but it does not read code: a suite it does not list is not proof (run the area's suites too).
import { execFileSync } from './helpers/child_process.js';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A revision argument goes to git as a revision, never as an option: one that starts with '-' is refused (--output=FILE would write a file). */
export function revArg(x) { if (typeof x === 'string' && x.startsWith('-')) throw new Error(`refusing "${x}": a revision does not start with "-"`); return x; }
/** A file name as a literal inside a RegExp. */
export const escapeRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MIN = 6;                                              // shorter tokens are common words and fragments
const SKIP = new Set(['button', 'dialog', 'hidden', 'true', 'false', 'object', 'string', 'number', 'function', 'return', 'default', 'change', 'click', 'submit', 'status', 'content', 'display', 'center']);

export function tokensOf(line) {
    const out = new Set();
    for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) out.add(m[1] ?? m[2] ?? m[3]);
    for (const m of line.matchAll(/\b(?:class|id|aria-label|title|placeholder)="([^"]*)"/g)) { out.add(m[1]); if (m[0].startsWith('class')) for (const c of m[1].split(/\s+/)) out.add(c); }
    for (const m of line.matchAll(/>([^<>{}$]{2,})</g)) out.add(m[1].trim());
    for (const m of line.matchAll(/\.([a-z][\w-]{4,})\b(?=[^;]*\{)/gi)) out.add(m[1]); // css selectors
    return [...out].map(t => t.replace(/\\(.)/g, '$1').trim()).filter(t => t.length >= MIN && /[A-Za-z]/.test(t) && !SKIP.has(t.toLowerCase()) && !/^\$\{/.test(t));
}

/** The tokens each changed file removed (and did not write back), and the changed test helpers. `diff` is `git diff -U0` text. */
export function removedTokens(diff) {
    const files = new Map(); let file = null;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
        if (line.startsWith('--- ') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('@@')) continue;
        if (!file || file === '/dev/null' || !/^[-+]/.test(line)) continue;
        const f = files.get(file) || { minus: [], plus: [] }; files.set(file, f);
        (line[0] === '-' ? f.minus : f.plus).push(line.slice(1));
    }
    const tokens = new Map(), helpers = [];
    for (const [file, { minus, plus }] of files) {
        if (/^tests\/frontend\/(helpers\/|[^/]*harness[^/]*)/.test(file)) { helpers.push(file); continue; }
        if (/^tests\//.test(file) || /_test\.go$/.test(file) || !/\.(js|mjs|html|css|go)$/.test(file)) continue;
        const written = new Set(plus.flatMap(tokensOf)), joined = plus.join('\n');
        for (const t of minus.flatMap(tokensOf)) if (!written.has(t) && !joined.includes(t)) tokens.set(t, file);
    }
    return { tokens, helpers };
}

/** `suites` maps a suite's path to its text. Returns { path: [why...] } for the suites a change can break. */
export function affected({ tokens, helpers }, suites) {
    const out = new Map();
    for (const [path, full] of suites) {
        const why = [], text = full.toLowerCase(); // a suite often says the words inside a longer sentence, in another case
        for (const [t, from] of tokens) if (text.includes(t.toLowerCase().replace(/[.:]$/, ''))) { why.push(`"${t.length > 60 ? t.slice(0, 57) + '...' : t}" (removed from ${basename(from)})`); if (why.length >= 3) break; }
        for (const h of helpers) { const name = escapeRe(basename(h).replace(/\.[cm]?js$/, '')); if (new RegExp(`require\\(['"]\\./(?:helpers/)?${name}(?:\\.js)?['"]\\)|from ['"]\\./(?:helpers/)?${name}(?:\\.[cm]?js)?['"]`).test(full)) why.push(`imports ${h}`); }
        if (why.length) out.set(path, why);
    }
    return out;
}

function main() {
    const [base, head] = process.argv.slice(2);
    try { revArg(base); revArg(head); } catch (e) { console.error(e.message); process.exit(2); }
    if (!base) { console.error('usage: node tests/frontend/affected_suites.mjs <base> [<head>]'); process.exit(2); }
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const diff = execFileSync('git', ['diff', '-U0', '--no-color', base, ...(head ? [head] : []), '--'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
    const dir = join(root, 'tests/frontend');
    const suites = new Map(readdirSync(dir).filter(f => /\.test\.(js|mjs)$/.test(f)).map(f => ['tests/frontend/' + f, readFileSync(join(dir, f), 'utf8')]));
    const hit = affected(removedTokens(diff), suites);
    if (!hit.size) { console.log('No suite contains a string, class, id or label this diff removes.'); return; }
    const browser = [...hit.keys()].filter(p => /_browser\.test\.js$/.test(p)).map(p => basename(p).replace(/\.test\.js$/, ''));
    for (const [p, why] of hit) console.log(`${p}\n    ${why.join('\n    ')}`);
    console.log(`\n${hit.size} suite(s). Run the browser ones on a free box before submit-review:`);
    if (browser.length) console.log(`  node tests/frontend/run_cdp_suites.mjs --retries 0 --only ${browser.join(',')}`);
    const node = [...hit.keys()].filter(p => !/_browser\.test\.js$/.test(p));
    if (node.length) console.log(`  node tests/frontend/${node.map(p => basename(p)).join('; node tests/frontend/')}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
