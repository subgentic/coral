// The button family's accessibility (#9544, after #9480, #9484, #9494, #9505 and #9509): every quiet and dense icon button has a visible keyboard focus ring (3:1 against the surface it sits on, in both themes),
// a hover state that survives high contrast (forced colors drops fills), an accessible name when it is icon-only, and a pressed toggle says aria-pressed. This census reads the stylesheets, the templates and the scripts:
//   1. the focus ring is --accent at 2 px (base.css, and the dense button's own inside its box), and the accent is at least 3:1 against every surface of the dark and light themes (the hover fill included);
//   2. the family's hover and focus have a forced-colors rule (a border or outline in Highlight), and no rule removes the focus outline of a button class (the allowlist names why one may);
//   3. every .btn-icon and .btn-xs button in markup has an aria-label, a title or visible text, or its id or class is named by a script that sets one;
//   4. a script that toggles the family's .is-on look sets aria-pressed (a toggle says it is on to a screen reader).
//   node button_a11y_census.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend');
const rd = p => fs.readFileSync(path.join(root, p), 'utf8');
const walk = (dir, ext, out = []) => { for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) { const rel = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(rel, ext, out); } else if (ext.some(x => e.name.endsWith(x))) out.push(rel); } return out; };
const problems = [];

// ── 1. the ring's contrast, from the theme tokens ─────────────────────────────────────────────────────────────────────────────────────────────────────
const lum = hex => { const h = hex.replace('#', ''); const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
assert.ok(Math.abs(ratio('#ffffff', '#000000') - 21) < 0.01, 'the contrast function: white on black is 21');
const vars = rd('static/css/variables.css');
const block = start => { const i = vars.indexOf(start); assert.ok(i >= 0, `variables.css has ${start}`); return vars.slice(i, vars.indexOf('\n}', i)); };
const token = (b, name) => { const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(b); assert.ok(m, `--${name} is a hex colour in its theme`); return m[1]; };
for (const [theme, start] of [['dark', '[data-theme="dark"] {'], ['light', '[data-theme="light"] {']]) {
    const b = block(start), accent = token(b, 'accent');
    for (const s of ['bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-hover']) {
        const r = ratio(accent, token(b, s));
        if (r < 3) problems.push(`${theme}: the focus ring (--accent ${accent}) is ${r.toFixed(2)}:1 on --${s}, under 3:1`);
    }
}
const base = rd('static/css/base.css'), comp = rd('static/css/components.css'), fc = rd('static/css/forced-colors.css');
if (!/button:focus-visible[\s\S]{0,200}\{\s*outline:\s*2px solid var\(--accent\);/.test(base)) problems.push('base.css: button:focus-visible is not a 2 px --accent outline');
if (!/\.btn-icon\.btn-xs:focus-visible \{ outline: 2px solid var\(--accent\);/.test(comp)) problems.push('components.css: the dense icon button has no 2 px --accent focus ring of its own');

// ── 2. hover and focus in forced colors; no rule that removes a button's outline ──────────────────────────────────────────────────────────────────────
for (const [what, re] of [
    ['the quiet button hover (.btn-quiet:hover)', /\.btn-quiet:hover[^{]*\{[^}]*Highlight/],
    ['the dense icon button hover (.btn-icon.btn-xs:hover)', /\.btn-icon\.btn-xs:hover[^{]*\{[^}]*Highlight/],
    ['the segment hover (.btn-seg > .btn:hover)', /\.btn-seg > \.btn:hover[^{]*\{[^}]*Highlight/],
    ['the dense icon button focus ring (.btn-icon.btn-xs:focus-visible)', /\.btn-icon\.btn-xs:focus-visible[^{]*\{[^}]*Highlight/],
]) if (!re.test(fc)) problems.push(`forced-colors.css: ${what} has no Highlight rule (the fill is dropped, so the state would not show)`);
const OUTLINE_OK = { 'li > .row-btn:focus-visible': 'a list row button: the row draws its own focus ring (the list row family)' };
for (const f of walk('static/css', ['.css'])) {
    const text = rd(f).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = m[1].trim().replace(/\s+/g, ' ');
        if (/outline\s*:\s*(none|0)\b|outline-width\s*:\s*0/.test(m[2]) && /:focus/.test(sel) && /btn|button|-icon|chip/.test(sel) && !(sel in OUTLINE_OK)) problems.push(`${f}: "${sel}" removes a button's focus outline: add it to OUTLINE_OK with the reason, or draw another ring`);
    }
}

// ── 3. an icon-only button has a name ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sources = [...walk('static', ['.js']), ...walk('templates', ['.html'])];
const text = Object.fromEntries(sources.map(f => [f, rd(f)]));
const allText = Object.values(text).join('\n');
const NAMED_BY_SCRIPT = (idOrClass) => new RegExp(`(?:${idOrClass.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')})[\\s\\S]{0,240}(?:aria-label|\\.title\\s*=|setAttribute\\(\\s*['"]title|setLabel|setTitle|setAttr)`).test(allText);
const EXEMPT_NAME = { 'emoji-picker-btn': 'its text is the emoji, which a screen reader names' };
let checked = 0;
for (const [f, s] of Object.entries(text)) {
    for (const m of s.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
        const attrs = m[1], inner = m[2];
        if (!/btn-icon|btn-xs/.test(attrs)) continue;
        checked++;
        if (/aria-label\s*=|aria-labelledby|\btitle\s*=/.test(attrs)) continue;
        const words = inner.replace(/<[^>]*>/g, '').replace(/\$\{[^}]*\}/g, '').replace(/&[a-z]+;/g, '').trim();
        if (words && !/^[a-z_]+$/.test(words)) continue; // visible text that is not a Material icon's name
        const classes = (/class="([^"]*)"/.exec(attrs) || [, ''])[1].split(/\s+/);
        const exempt = classes.find(c => c in EXEMPT_NAME);
        if (exempt) continue;
        const id = (/\bid="([^"$]+)"/.exec(attrs) || [, ''])[1], own = classes.filter(c => c && !/^(btn|btn-quiet|btn-icon|btn-xs|btn-small|btn-danger|btn-primary)$/.test(c));
        if ((id && NAMED_BY_SCRIPT(id)) || own.some(NAMED_BY_SCRIPT)) continue;
        problems.push(`${f}: an icon-only button with no name: ${attrs.trim().slice(0, 90)}`);
    }
    for (const m of s.matchAll(/(?:el|createElement)\(\s*['"]button['"]\s*,\s*['"]([^'"]*(?:btn-icon|btn-xs)[^'"]*)['"]/g)) {
        checked++;
        const ctx = s.slice(m.index, m.index + 700);
        if (!/aria-label|setAttribute\(\s*['"]title|\.title\s*=|ariaLabel|\btitle:/.test(ctx)) problems.push(`${f}: a script-built icon button with no name near its creation: ${m[1]}`);
    }
}
assert.ok(checked >= 30, `the census looked at the icon buttons (${checked})`);

// ── 4. a toggle's pressed look says aria-pressed ──────────────────────────────────────────────────────────────────────────────────────────────────────
for (const [f, s] of Object.entries(text)) if (/classList\.(toggle|add|remove)\(\s*['"]is-on['"]/.test(s) && !/aria-pressed/.test(s)) problems.push(`${f}: toggles the family's .is-on look without aria-pressed`);

assert.deepEqual(problems, [], 'the button family\'s accessibility:\n  ' + problems.join('\n  '));
console.log(`button_a11y_census: ok (the ring is --accent 2 px, over 3:1 on every dark and light surface; hover and focus have forced-colors rules; ${checked} icon buttons are named; no button outline is removed)`);
