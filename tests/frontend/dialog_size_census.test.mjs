// The three dialog sizes (Goal #89, #9320): a dialog wears .dlg-confirm (28 rem), .dlg-form (40 rem) or .dlg-flow (60 rem, at most 94vw) and is never wider than --dlg-max (95vw); a width is nowhere else. A stylesheet rule for a
// dialog (a .modal-content, a dialog element, a .dlg-* or *-dialog / *-confirm class) that sets width, max-width or min-width to a literal (a rem, a px, a vw) is a one-off size: this census fails on one that is not in
// dialog_size_baseline.json, and on a template's inline width on a .modal-content; the baseline only goes down (lower it with `node dialog_size_census.test.mjs --update`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend');
const CSS = path.join(FE, 'static', 'css');
const BASELINE = path.join(HERE, 'dialog_size_baseline.json');
const update = process.argv.includes('--update');
const DIALOG = /(^|\.)(modal-content|dlg-[a-z]+|[a-z-]*-modal-content|[a-z-]*-dialog|[a-z-]*-confirm|editions-content)(::?[a-z-]+)*$|^dialog(\.[a-z-]+)*(::?[a-z-]+)*$/;
const ALLOWED = /^(none|auto|100%|100vw|100dvw|0|1px|var\(--[a-z-]+[^)]*\)|min\(var\(--dlg-[a-z-]+\)[^)]*\)|inherit|initial|fit-content|min-content|max-content)$/;

/** Every `selector { prop: value }` that gives a dialog a literal width: a size of its own. */
export function scan(css) {
    const out = [];
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const raw of m[1].split(',')) {
            const sel = raw.trim().replace(/\s+/g, ' ');
            if (!sel || sel.startsWith('@')) continue;
            const last = sel.split(/[\s>+~]+/).pop();
            if (!DIALOG.test(last)) continue;
            for (const d of m[2].matchAll(/(?<![-\w])((?:max-|min-)?width)\s*:\s*([^;]+)/g)) {
                const v = d[2].replace(/!important/, '').trim();
                if (!ALLOWED.test(v)) out.push(`${sel} { ${d[1]}: ${v} }`);
            }
        }
    }
    return out;
}

assert.deepEqual(scan('.modal-content { max-width: 90vw; } .dlg-form { width: var(--dlg-w-form); } dialog.x { width: min(460px, 100vw); } .foo { width: 3px; } .a-dialog { max-width: 100%; } .b-modal-content { width: 38rem !important; }'), ['.modal-content { max-width: 90vw }', 'dialog.x { width: min(460px, 100vw) }', '.b-modal-content { width: 38rem }']);

const now = {};
for (const f of fs.readdirSync(CSS).filter(n => n.endsWith('.css')).sort()) for (const k of scan(fs.readFileSync(path.join(CSS, f), 'utf8'))) now[`${f}: ${k}`] = 1;
const inline = [];
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk(path.join(FE, 'templates'))) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (/class="[^"]*\b(modal-content|dlg-[a-z]+)\b[^"]*"[^>]*style="[^"]*width/.test(l)) inline.push(`${path.relative(FE, f)}:${i + 1}`); });
if (update) { fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n'); console.log('dialog_size_census: baseline written, ' + Object.keys(now).length + ' dialog size rules'); process.exit(0); }
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const bad = [];
for (const k of Object.keys(now)) if (!(k in base)) bad.push(`${k}: a dialog size of its own: wear .dlg-confirm, .dlg-form or .dlg-flow (width) and --dlg-max (the screen)`);
for (const k of Object.keys(base)) if (!(k in now)) bad.push(`${k} is gone or changed: lower the baseline (node dialog_size_census.test.mjs --update)`);
for (const l of inline) bad.push(`${l}: an inline width on a dialog: wear a .dlg-* size`);
assert.deepEqual(bad, [], 'dialog size census');
console.log(`dialog_size_census: ok (${Object.keys(now).length} one-off dialog sizes in the baseline; goal #89 is done when it is empty)`);
