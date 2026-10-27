// A selector written twice in one stylesheet and one @media context (Goal #89, #9345 follow-up): the second block is an override of the first, so a reader has to hold both to know what the class looks like (the same selector
// with the same declarations is css_syntax's fault). The count is in css_duplicate_baseline.json, keyed by file, @-context and selector; it only goes down: a selector written more often than its baseline, or a new one, fails, and one
// that was merged lists itself to be lowered (`node css_duplicate_census.test.mjs --update`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend', 'static', 'css');
const BASELINE = path.join(HERE, 'css_duplicate_baseline.json');
const update = process.argv.includes('--update');

/** { "@-context | selector": number of blocks } for the selectors written more than once in this stylesheet. */
export function duplicates(css) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const count = new Map();
    const stack = []; // the open blocks: { at: the @-prelude of a group, or '' for a rule }
    let prelude = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '{') {
            const p = prelude.replace(/\s+/g, ' ').trim();
            const inRule = stack.some(b => b.at === '');
            if (p.startsWith('@')) stack.push({ at: /^@(media|supports|layer|container)\b/i.test(p) ? p : p + ' (own)' });
            else { if (!inRule) { const key = stack.map(b => b.at).join(' > ') + ' | ' + p; count.set(key, (count.get(key) || 0) + 1); } stack.push({ at: '' }); }
            prelude = '';
        } else if (c === '}') { stack.pop(); prelude = ''; }
        else if (c === ';') prelude = '';
        else if (c === '"' || c === "'") { let j = i + 1; while (j < text.length && text[j] !== c) { if (text[j] === '\\') j++; j++; } prelude += text.slice(i, j + 1); i = j; }
        else prelude += c;
    }
    return Object.fromEntries([...count].filter(([, n]) => n > 1));
}

assert.deepEqual(duplicates('.a { color: red; } .a { color: blue; } .b { color: red; } @media (x) { .a { color: red; } .a { color: red; } } .c:hover { x: 1; } .c:hover { y: 2; } /* .d { } .d { } */'), { ' | .a': 2, '@media (x) | .a': 2, ' | .c:hover': 2 });
assert.deepEqual(duplicates('.a { color: red; &:hover { x: 1; } &:hover { y: 2; } }'), {}, 'a nested rule is not a top-level selector');

const now = {};
for (const f of fs.readdirSync(CSS).filter(n => n.endsWith('.css')).sort()) for (const [k, n] of Object.entries(duplicates(fs.readFileSync(path.join(CSS, f), 'utf8')))) now[`${f}: ${k}`] = n;
if (update) { fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n'); console.log('css_duplicate_census: baseline written, ' + Object.keys(now).length + ' selectors'); process.exit(0); }
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const bad = [];
for (const [k, n] of Object.entries(now)) {
    if (!(k in base)) bad.push(`${k}: a selector written ${n} times in one stylesheet: merge the blocks`);
    else if (n > base[k]) bad.push(`${k}: written ${n} times, the baseline allows ${base[k]}`);
    else if (n < base[k]) bad.push(`${k}: written ${n} times, the baseline has ${base[k]}: lower it (node css_duplicate_census.test.mjs --update)`);
}
for (const k of Object.keys(base)) if (!(k in now)) bad.push(`${k} is merged: lower the baseline (node css_duplicate_census.test.mjs --update)`);
assert.deepEqual(bad, [], 'css duplicate census');
console.log(`css_duplicate_census: ok (${Object.keys(now).length} selectors written more than once in a stylesheet, all in the baseline; it only goes down)`);
