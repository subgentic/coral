// One icon size scale (Goal #88, spec item 6, #9246): --icon-sm 16, --icon 18, --icon-lg 24 and --icon-xl 32 px (variables.css, in rem so they follow the text size). A stylesheet rule for a .material-icons element or an icon
// class (*-icon) that sets a font-size, or for an svg that sets a width or a height, takes one of those four tokens (or inherit / 100% / 1em: the glyph follows its box). Any other value is a size of its own: this census fails on one that
// is not in icon_baseline.json (keyed by selector, property and value) and when one in the baseline is gone or changed; the baseline only goes down (lower it with `node icon_census.test.mjs --update`).
// The small glyphs (10 to 14 px, the audit's tag removers, filters and dir icons) are in the baseline until their own slice; the audit's 15, 17, 19, 20 and 21 px glyphs are on the scale.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend', 'static', 'css');
const BASELINE = path.join(HERE, 'icon_baseline.json');
const update = process.argv.includes('--update');
export const TOKENS = new Set(['var(--icon-sm)', 'var(--icon)', 'var(--icon-lg)', 'var(--icon-xl)', 'inherit', '100%', '1em', 'auto']);

/** Every `selector prop: value` that sizes an icon off the scale. A rule's last compound decides what it sizes: .material-icons or *-icon (font-size), svg (width, height). */
export function scan(css) {
    const out = [];
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const raw of m[1].split(',')) {
            const sel = raw.trim().replace(/\s+/g, ' ');
            if (!sel || sel.startsWith('@') || /\[(width|height)/.test(sel)) continue; // an svg sized by its own attribute is scaled with the text by touch.css, not an icon rule
            const last = sel.split(/[\s>+~]+/).pop().replace(/(::?[a-z-]+(\([^)]*\))?|\[[^\]]*\])+$/g, '');
            const props = /(^|[.\s])material-icons$/.test(last) || /-(icon|arrow)$|\.icon$/.test(last) ? ['font-size'] : /(^|[.\s#])svg$|^svg$/.test(last) ? ['width', 'height'] : [];
            for (const p of props) for (const d of m[2].matchAll(new RegExp('(?<![-\\w])' + p + '\\s*:\\s*([^;]+)', 'g'))) {
                const v = d[1].replace(/!important/, '').trim();
                if (!TOKENS.has(v)) out.push(`${sel} { ${p}: ${v} }`);
            }
        }
    }
    return out;
}

assert.deepEqual(scan('.a .material-icons { font-size: 1.1rem; } .b-icon { font-size: var(--icon); } .c svg { width: 20px; height: 100%; } .d { font-size: 3px; } .e-icon:hover { font-size: 9px !important; }'), ['.a .material-icons { font-size: 1.1rem }', '.c svg { width: 20px }', '.e-icon:hover { font-size: 9px }']);

const now = {};
for (const f of fs.readdirSync(CSS).filter(n => n.endsWith('.css')).sort()) for (const k of scan(fs.readFileSync(path.join(CSS, f), 'utf8'))) now[`${f}: ${k}`] = 1;
if (update) { fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n'); console.log('icon_census: baseline written, ' + Object.keys(now).length + ' off-scale sizes'); process.exit(0); }
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const bad = [];
for (const k of Object.keys(now)) if (!(k in base)) bad.push(`${k}: an icon size off the scale: use var(--icon-sm), var(--icon), var(--icon-lg) or var(--icon-xl)`);
for (const k of Object.keys(base)) if (!(k in now)) bad.push(`${k} is gone or changed: lower the baseline (node icon_census.test.mjs --update)`);
assert.deepEqual(bad, [], 'icon census');
console.log(`icon_census: ok (${Object.keys(now).length} off-scale icon sizes in the baseline; goal #88 is done when only the small-glyph slice is left)`);
