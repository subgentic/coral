// Every confirm dialog names its choice (#9318): a question that loses something (a delete, a kill, a discard) passes { danger: true } and gets the danger button; one that loses nothing
// (a sleep, an archive, a paste, a restart) passes { danger: false } and gets the primary. The dialog's default is the primary, so a caller that forgets would be a destructive question in the
// plain style: this census reads every call of showConfirmModal (and the wrappers confirmWith and this.confirm) and fails on one with no `danger` in its arguments.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const CALL = /(?<![\w.$])((?:window\.|this\.)?(?:showConfirmModal|confirmWith|confirm))(\?\.)?\(/g;
const NAMES = new Set(['showConfirmModal', 'window.showConfirmModal', 'confirmWith', 'this.confirm']);

/** The index of the ")" that closes the "(" at i, skipping strings, template literals (with their ${}), and comments. */
export function close(s, i) {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
        const c = s[j];
        if (c === '"' || c === "'") { const q = c; for (j++; s[j] !== q; j++) if (s[j] === '\\') j++; }
        else if (c === '`') j = template(s, j);
        else if (c === '/' && s[j + 1] === '/') { while (s[j] !== '\n') j++; }
        else if (c === '/' && s[j + 1] === '*') j = s.indexOf('*/', j) + 1;
        else if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) return j; }
    }
    throw new Error('no closing parenthesis');
}
function template(s, j) {
    for (j++; s[j] !== '`'; j++) {
        if (s[j] === '\\') j++;
        else if (s[j] === '$' && s[j + 1] === '{') j = close(s, j + 1);
    }
    return j;
}

/** Calls (name, line, args text) that ask a confirm question in one file's text. */
export function calls(text) {
    const out = [];
    for (const m of text.matchAll(CALL)) {
        const name = m[1];
        if (!NAMES.has(name)) continue;
        const before = text.slice(Math.max(0, m.index - 24), m.index);
        if (/function\s+$/.test(before) || /(import|export)\b[^;\n]*$/.test(text.slice(text.lastIndexOf('\n', m.index) + 1, m.index))) continue; // a definition, an import or a re-export
        if (name === 'this.confirm' && /^\s*=/.test(text.slice(m.index + name.length, m.index + name.length + 4))) continue;
        const open = m.index + m[0].length - 1, end = close(text, open);
        out.push({ name, line: text.slice(0, m.index).split('\n').length, args: text.slice(open + 1, end) });
    }
    return out;
}

// the scan catches a call with no choice, and passes the forms that name one
assert.equal(calls("window.showConfirmModal('Delete x', 'sure?', () => go());").filter(c => !/\bdanger\b/.test(c.args)).length, 1);
assert.equal(calls("showConfirmModal('Delete x', `a ${b(')')} (c)`, () => { go(); }, undefined, { danger: true });").filter(c => !/\bdanger\b/.test(c.args)).length, 0);
assert.equal(calls("function confirmWith(t, m) { return 1; }\nexport { showConfirmModal } from './confirm_dialog.js';\nconst f = x => confirm(1);").length, 0);

const problems = []; let n = 0;
for (const f of fs.readdirSync(STATIC).filter(f => f.endsWith('.js')).sort()) {
    for (const c of calls(fs.readFileSync(path.join(STATIC, f), 'utf8'))) {
        n++;
        if (!/\bdanger\b/.test(c.args)) problems.push(`${f}:${c.line}: ${c.name}( names no choice: pass { danger: true } for a question that loses something, { danger: false } for one that loses nothing`);
    }
}
assert.ok(n >= 25, `the scan found only ${n} confirm calls: the pattern is broken`);
assert.deepEqual(problems, [], problems.join('\n'));
console.log(`confirm_census: ok (${n} confirm questions, each names danger true or false)`);
