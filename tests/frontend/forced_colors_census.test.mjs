// Every class a forced-colors rule names is still built (#9775, QA Engineer's note on #9759). The forced-colors rules are the ones nothing
// shows in a normal run: a badge's border, a dot's outline, a pressed toggle. When the code that drew a badge goes (the agent cards, #9740),
// its class stays named in the rule and nobody notices; and when the rule itself is dropped (ce1946c0c) no suite named every badge. This reads
// forced-colors.css and every `@media (forced-colors: ...)` block in the other stylesheets and fails on a class a script or a template does
// not build. Strict on purpose: only the frontend's own scripts and templates count (css_unused also takes the Go sources and the installers),
// and a name built from a prefix of two or more words (`viz-line-${i}`) counts, as there.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fe = path.join(path.resolve(here, '../..'), 'coral-go/pkg/frontend');
const st = path.join(fe, 'static');
const walk = (d, ok) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? (e.name === 'node_modules' || e.name === 'vendor' ? [] : walk(p, ok)) : ok(p) ? [p] : [];
});
const read = p => fs.readFileSync(p, 'utf8');
const noComments = (p, t) => p.endsWith('.js') ? t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1') : t.replace(/<!--[\s\S]*?-->/g, '');
const src = [...walk(st, p => /\.(js|html)$/.test(p)), ...walk(path.join(fe, 'templates'), p => p.endsWith('.html'))].map(p => noComments(p, read(p))).join('\n');
const tokens = new Set(src.match(/[A-Za-z_][A-Za-z0-9_-]*/g));
const prefixesOf = text => new Set([...text.matchAll(/([A-Za-z][A-Za-z0-9_-]*[-_])\$\{/g)].map(m => m[1]).concat([...text.matchAll(/['"]([A-Za-z][A-Za-z0-9_-]*[-_])['"]\s*\+/g)].map(m => m[1])));
const twoWords = ps => new Set([...ps].filter(p => p.split(/[-_]/).filter(Boolean).length >= 2));
const EXTERNAL = /^(cm-|xterm|hljs|material-icons)/; // drawn by libraries
const builtIn = (c, toks, pre) => toks.has(c) || EXTERNAL.test(c) || [...pre].some(p => c.startsWith(p));
const prefixes = twoWords(prefixesOf(src));

/** The CSS text of the forced-colors rules in a stylesheet: all of forced-colors.css, and the body of each `@media (forced-colors` block elsewhere. */
export const forcedCss = (file, text) => {
    const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
    if (path.basename(file) === 'forced-colors.css') return [css];
    const out = []; let i = 0;
    while ((i = css.indexOf('@media (forced-colors', i)) >= 0) {
        const open = css.indexOf('{', i); let depth = 1, k = open + 1;
        while (depth && k < css.length) { if (css[k] === '{') depth++; else if (css[k] === '}') depth--; k++; }
        out.push(css.slice(open + 1, k - 1)); i = k;
    }
    return out;
};
export const classesIn = css => new Set([...css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map(m => m[1]));

// The check itself: a class nothing builds is found, a prefix-built or literal one is not, and a media block is read to its closing brace.
const sample = forcedCss('x.css', '.a { color: red } @media (forced-colors: active) { .zz-not-built-anywhere { border: 0 } @media (min-width: 1px) { .viz-line-3 { x: y } } .real-badge { y: z } } .after { }');
assert.deepEqual([...classesIn(sample.join('\n'))].sort(), ['real-badge', 'viz-line-3', 'zz-not-built-anywhere'], 'a forced-colors block is read whole, a rule outside it is not');
assert.equal(builtIn('zz-not-built-anywhere', new Set(['real-badge']), new Set()), false, 'a class nothing builds is flagged');
assert.equal(builtIn('viz-line-3', new Set(), twoWords(prefixesOf('c = `viz-line-${i}`'))), true, 'a class built from a two-word prefix counts');
assert.equal(builtIn('team-x', new Set(), twoWords(prefixesOf('c = `team-${i}`'))), false, 'a one-word prefix excuses nothing');

const dead = [];
let blocks = 0;
for (const f of walk(path.join(st, 'css'), p => p.endsWith('.css'))) {
    for (const css of forcedCss(f, read(f))) { blocks++; for (const c of classesIn(css)) if (!builtIn(c, tokens, prefixes)) dead.push(`${path.basename(f)}: .${c}`); }
}
assert.ok(blocks >= 5, `the forced-colors blocks are found (${blocks})`);
const uniq = [...new Set(dead)].sort();
assert.deepEqual(uniq, [], `a forced-colors rule names classes nothing builds (remove the name, or build the class):\n  ${uniq.join('\n  ')}`);
console.log(`forced_colors_census: ok (${blocks} forced-colors blocks; every class they name is built)`);
