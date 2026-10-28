// A literal font size, weight, line height or font family (Goal #84, the type scale): the page has seven sizes (--fs-sm ... --fs-display in variables.css) and three families (--font-sans, --font-mono, the icon
// font). A `font-size` written as a number in a stylesheet, in a script's inline style (`style="font-size:..."`, `style.fontSize = '...'`) or in a template, and a `font-family` that is not
// a var(), `inherit` or the icon font, is the same size or face in every place that copies it, and is how the page came to have 43 different sizes. Write var(--fs-*) (and add a
// token when a size is needed in three places), var(--fw-*) for the three weights (700 only on a 20 or 32 px title) and var(--lh-*) for the three line heights (1, a length, or inherit are not ratios). What is here already is in fixtures/font_literals_allowlist.json, per file and declaration, with the count: the count may not go up,
// and it must come down when a use is fixed (the message says "lower it"), so the list only shrinks. CORAL_UPDATE_ALLOWLIST=1 rewrites it (review the diff: a new entry is a new literal).
// Not counted: a size or family that is a var(), `inherit`/`initial`/`unset`, and a `--name: value` line (a token definition). A standalone export document (board_export_render.js) and the
// terminal's own options (xterm's fontSize) are in the list or out of the scan, each for its reason.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fe = path.join(root, 'coral-go/pkg/frontend');
const ALLOW = path.join(here, 'fixtures', 'font_literals_allowlist.json');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? (e.name === 'vendor' || e.name === 'node_modules' ? [] : walk(p)) : [p];
});
const blank = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
const SIZE = /(?<![\w-])font-size\s*:\s*([^;}"'`{]+?)\s*(?:!important)?\s*(?=[;}"'`]|$)/g;
const FAMILY = /(?<![\w-])font-family\s*:\s*([^;}"`{]+?)\s*(?:!important)?\s*(?=[;}"`]|$)/g;
const STYLE_SIZE = /\.style\.fontSize\s*=\s*['"`]([^'"`]+)['"`]/g;
const WEIGHT = /(?<![\w-])font-weight\s*:\s*([^;}"'`{]+?)\s*(?:!important)?\s*(?=[;}"'`]|$)/g;
const LINE = /(?<![\w-])line-height\s*:\s*([^;}"'`{]+?)\s*(?:!important)?\s*(?=[;}"'`]|$)/g;
// a `font:` shorthand is a size, weight and family in one: each part is a token (var(--fw-*) var(--fs-*)/var(--lh-*) var(--font-*)) or the whole is a var(--dlg-*) / inherit (#9741)
const SHORTHAND = /(?<![\w-])font\s*:\s*([^;}"'`{]+?)\s*(?:!important)?\s*(?=[;}"'`]|$)/g;
const LETTER = /(?<![\w-])letter-spacing\s*:\s*([^;}"'`{]+?)\s*(?:!important)?\s*(?=[;}"'`]|$)/g;
// a tracking of 0, normal or inherited is not a step; any other length is a --ls-* token
const okLetter = (v) => ok(v) || /^(0|normal)$/.test(v.trim());
const okShorthand = (v) => ok(v) || /^(caption|icon|menu|message-box|small-caption|status-bar)$/.test(v.trim());
const STYLE_FAMILY = /\.style\.fontFamily\s*=\s*['"`]([^'"`]+)['"`]/g;
// a line height that is a length (a control's fixed height), 1 or 0 (an icon's), or inherited is not one of the three ratios
const okLine = (v) => ok(v) || /^(1|0)$/.test(v.trim()) || /^[0-9.]+(px|rem|em)$/.test(v.trim()) || /^normal$/i.test(v.trim());
const okWeight = (v) => ok(v);
// a size in em follows the text it sits in (rendered prose, an inline code span, a placeholder scale): it is a ratio, not a step of the scale
const relEm = (v) => /^[0-9.]*em$/.test(v.trim()) || /^calc\(\s*1em\b/.test(v.trim());
// the icon font is the one face that is not a --font-* token
const iconFont = (v) => /^['"]?Material Icons['"]?$/.test(v.trim());
// files that are not the dashboard's styles, each for its reason
export const EXEMPT_FILES = {
    'coral-go/pkg/frontend/static/css/fonts.css': 'the @font-face declarations (family, weight range) and the icon font\'s own base size: they define the faces, they do not use them',
    'coral-go/pkg/frontend/static/board_export_render.js': 'a standalone export document that leaves the dashboard as its own page and carries its own styles',
    'coral-go/pkg/frontend/static/platform/native.js': 'the native shell\'s splash, drawn before the dashboard\'s stylesheets load',
};
const ok = (v) => /^(var\(|inherit$|initial$|unset$|revert)/i.test(v.trim()) || /\$\{/.test(v);

export function scan() {
    const out = {};
    const add = (file, what, v) => { const k = `${what}: ${v.trim().replace(/\s+/g, ' ')}`; (out[file] ||= {})[k] = (out[file][k] || 0) + 1; };
    const files = [...walk(path.join(fe, 'static')), ...walk(path.join(fe, 'templates'))].filter(f => /\.(css|js|html)$/.test(f));
    for (const f of files) {
        const rel = path.relative(root, f).split(path.sep).join('/');
        if (rel in EXEMPT_FILES) continue;
        let text = fs.readFileSync(f, 'utf8');
        if (f.endsWith('.css')) text = blank(text);
        const lines = text.split('\n');
        lines.forEach((line) => {
            if (/^\s*--[\w-]+\s*:/.test(line)) return; // a token definition
            for (const m of line.matchAll(SIZE)) if (!ok(m[1]) && !relEm(m[1])) add(rel, 'font-size', m[1]);
            for (const m of line.matchAll(FAMILY)) if (!ok(m[1]) && !iconFont(m[1])) add(rel, 'font-family', m[1]);
            for (const m of line.matchAll(WEIGHT)) if (!okWeight(m[1])) add(rel, 'font-weight', m[1]);
            for (const m of line.matchAll(LINE)) if (!okLine(m[1])) add(rel, 'line-height', m[1]);
            for (const m of line.matchAll(SHORTHAND)) if (!okShorthand(m[1]) && /(^|\s)([0-9.]+(rem|px|em)|[1-9]00)(\/|\s|$)/.test(m[1])) add(rel, 'font', m[1]);
            for (const m of line.matchAll(LETTER)) if (!okLetter(m[1])) add(rel, 'letter-spacing', m[1]);
            for (const m of line.matchAll(STYLE_SIZE)) if (!ok(m[1])) add(rel, 'style.fontSize', m[1]);
            for (const m of line.matchAll(STYLE_FAMILY)) if (!ok(m[1])) add(rel, 'style.fontFamily', m[1]);
        });
    }
    return out;
}

const found = scan();
if (process.env.CORAL_UPDATE_ALLOWLIST) {
    fs.mkdirSync(path.dirname(ALLOW), { recursive: true });
    const sorted = Object.fromEntries(Object.keys(found).sort().map(f => [f, Object.fromEntries(Object.keys(found[f]).sort().map(k => [k, found[f][k]]))]));
    fs.writeFileSync(ALLOW, JSON.stringify({ about: 'A literal font size or family, per file and declaration, with its count. Fixing one lowers the count here (font_literal_census.test.mjs); a new one fails the test.', files: sorted }, null, 2) + '\n');
    console.log('allowlist written: ' + Object.keys(sorted).length + ' files');
    process.exit(0);
}
const allow = JSON.parse(fs.readFileSync(ALLOW, 'utf8')).files;
const problems = [];
for (const [file, kinds] of Object.entries(found)) {
    for (const [k, n] of Object.entries(kinds)) {
        const had = (allow[file] || {})[k] || 0;
        if (n > had) problems.push(`${file}: "${k}" ${had === 0 ? 'is new' : `is used ${n} times, the list has ${had}`}: use var(--fs-*) / var(--font-*) (variables.css), or add the token`);
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
console.log(`font_literal_census: ok (${total} literal font sizes and families left in the list, in ${Object.keys(found).length} files)`);
