// The design guidelines as a static guard (#15818, Design S6), so fixes stay fixed. Three rules, each counted per file against an allow-list of today's breaks that only shrinks:
//  1. a corner radius is 4, 6, 8 or 12 px, or 50% (or a var(), 0, inherit); the tokens in variables.css are the steps (--radius-sm 4, -md 6, -lg 8, -xl 12).
//  2. a fixed height or min-height on a control (a rule whose selector names a button, input, select, textarea, .btn, .field, a chip or a control) is 32, 36 or 44 px (or a var()/calc of tokens).
//  3. no dialog and no page header holds two .btn-primary: in markup (a <dialog> or <header> block with two) and in a script that builds a dialog (a file that makes a dialog and writes
//     'btn-primary' more than once is counted, so a new second primary in it fails until it is fixed or listed).
// The list below is what breaks today. Fixing one lowers its count and the test says "lower it"; a new break fails. CORAL_UPDATE_ALLOWLIST=1 rewrites the list (review the diff: a new entry is a new break).
// Not counted: a token definition other than --radius-* (a `--name: value` line), the vendor folder, and CSS inside a comment.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fe = path.join(root, 'coral-go/pkg/frontend');
const ALLOW = path.join(here, 'fixtures', 'design_guidelines_allowlist.json');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? (e.name === 'vendor' || e.name === 'node_modules' ? [] : walk(p)) : [p];
});
const blank = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));

export const RADII = new Set(['4px', '6px', '8px', '12px', '50%', '0', '0px']);
export const HEIGHTS = new Set(['32px', '36px', '44px']);
const KEYWORD = /^(inherit|initial|unset|revert|none|auto)$/i;
const isToken = v => /^var\(/i.test(v.trim()) || /\$\{/.test(v);
const norm = v => v.trim().replace(/\s+/g, ' ').replace(/\s*!important$/, '');
/** The break in a border-radius value, or '' when every part is a step: "10px 4px" is a break because of the 10px. */
export function radiusBreak(v) {
    const parts = norm(v).replace(/var\((?:[^()]|\([^()]*\))*\)/gi, 'var()').split(/[\s/]+/).filter(Boolean); // a var() with its fallback is one part
    const bad = parts.filter(p => !(RADII.has(p) || isToken(p) || KEYWORD.test(p)));
    return bad.length ? norm(v) : '';
}
const CONTROL = /(^|[\s,>+~(])(button|input|select|textarea)\b|\.(btn|field|[\w-]*-?chip|[\w-]*control[\w-]*)\b|\[type=/i;
export const heightBreak = v => { const t = norm(v); return isToken(t) || HEIGHTS.has(t) || KEYWORD.test(t) || /^0(px)?$/.test(t) || /%$|v[hw]$|^(fit|max|min)-content$/.test(t) || /^calc\(.*var\(/.test(t) ? '' : t; };

/** Every rule of a stylesheet as { selector, body }: media and container blocks are looked through, keyframes and font-face are skipped. */
export function rules(css) {
    const text = blank(css), out = [];
    const walkBlock = (start, end) => {
        let i = start;
        while (i < end) {
            const open = text.indexOf('{', i);
            if (open < 0 || open >= end) break;
            let depth = 1, j = open + 1;
            while (j < end && depth) { const c = text[j++]; if (c === '{') depth++; else if (c === '}') depth--; }
            const head = text.slice(i, open).replace(/^[\s;}]+/, '').trim(), body = text.slice(open + 1, j - 1);
            if (/^@(media|container|supports|layer)\b/i.test(head)) walkBlock(open + 1, j - 1);
            else if (!head.startsWith('@')) out.push({ selector: head, body });
            i = j;
        }
    };
    walkBlock(0, text.length);
    return out;
}

export function scan() {
    const out = {};
    const add = (file, k) => { (out[file] ||= {})[k] = (out[file][k] || 0) + 1; };
    const files = [...walk(path.join(fe, 'static')), ...walk(path.join(fe, 'templates'))].filter(f => /\.(css|js|html)$/.test(f));
    for (const f of files) {
        const rel = path.relative(root, f).split(path.sep).join('/');
        const src = fs.readFileSync(f, 'utf8');
        if (f.endsWith('.css')) {
            for (const r of rules(src)) {
                for (const m of r.body.matchAll(/(?<![\w-])(--radius[\w-]*|border(?:-(?:top|bottom)-(?:left|right|start|end)|-start-start|-start-end|-end-start|-end-end)?-radius)\s*:\s*([^;}]+)/g)) {
                    const b = radiusBreak(m[2]); if (b) add(rel, `radius: ${m[1].startsWith('--') ? m[1] + ' = ' : ''}${b}`);
                }
                if (CONTROL.test(r.selector)) {
                    for (const m of r.body.matchAll(/(?<![\w-])(min-height|height)\s*:\s*([^;}]+)/g)) { const b = heightBreak(m[2]); if (b) add(rel, `height: ${r.selector.replace(/\s+/g, ' ').slice(0, 70)} { ${m[1]}: ${b} }`); }
                }
            }
        } else {
            const text = f.endsWith('.js') ? src : src;
            for (const m of text.matchAll(/(?<![\w-])border-radius\s*:\s*([^;}"'`]+)/g)) { const b = radiusBreak(m[1]); if (b) add(rel, `radius: inline ${b}`); }
            for (const m of text.matchAll(/\.style\.borderRadius\s*=\s*['"`]([^'"`]+)['"`]/g)) { const b = radiusBreak(m[1]); if (b) add(rel, `radius: style ${b}`); }
            for (const m of text.matchAll(/<(dialog|header)\b[^>]*>([\s\S]*?)<\/\1>/g)) { const n = (m[2].match(/btn-primary/g) || []).length; if (n > 1) add(rel, `two primaries in a ${m[1]} block`); }
            if (f.endsWith('.js') && /createElement\(['"]dialog['"]\)|<dialog\b|dialogShell|makeDialog/.test(text)) {
                const n = (text.match(/btn-primary/g) || []).length;
                if (n > 1) out[rel] = { ...(out[rel] || {}), 'btn-primary written in a dialog module': n };
            }
        }
    }
    return out;
}

const found = scan();
if (process.env.CORAL_UPDATE_ALLOWLIST) {
    fs.mkdirSync(path.dirname(ALLOW), { recursive: true });
    const sorted = Object.fromEntries(Object.keys(found).sort().map(f => [f, Object.fromEntries(Object.keys(found[f]).sort().map(k => [k, found[f][k]]))]));
    fs.writeFileSync(ALLOW, JSON.stringify({ about: 'Today\'s breaks of the design guidelines (corner radius, fixed control height, two primary buttons), per file with a count. Fixing one lowers the count here (design_guideline_census.test.mjs); a new one fails the test.', files: sorted }, null, 1) + '\n');
    console.log('allowlist written: ' + Object.keys(sorted).length + ' files');
    process.exit(0);
}
const allow = JSON.parse(fs.readFileSync(ALLOW, 'utf8')).files;
const problems = [];
for (const [file, kinds] of Object.entries(found)) {
    for (const [k, n] of Object.entries(kinds)) {
        const had = (allow[file] || {})[k] || 0;
        if (n > had) problems.push(`${file}: "${k}" ${had === 0 ? 'is new' : `is used ${n} times, the list has ${had}`}: radii are 4, 6, 8, 12 px or 50% (--radius-*); a control is 32, 36 or 44 px tall (--toolbar-control-h, --control-height, --control-touch-height); one primary button to a dialog or header`);
    }
}
for (const [file, kinds] of Object.entries(allow)) {
    for (const [k, had] of Object.entries(kinds)) {
        const n = (found[file] || {})[k] || 0;
        if (n < had) problems.push(`${file}: "${k}" is used ${n} times, the list still has ${had}: lower it (CORAL_UPDATE_ALLOWLIST=1 rewrites the list; review the diff)`);
    }
}
assert.deepEqual(problems, [], '\n' + problems.join('\n'));
const total = Object.values(found).reduce((a, k) => a + Object.values(k).reduce((x, y) => x + y, 0), 0);
console.log(`design_guideline_census: ok (${total} breaks left in the list, in ${Object.keys(found).length} files)`);
