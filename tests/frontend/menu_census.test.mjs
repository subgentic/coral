// One menu (Goal #88, spec item 1): a menu is `.menu` with `.menu-item` rows (layout.css) and its keys are menu_keys.js. A page's own class for a menu (team-more-menu ...) says where it sits and how wide it is.
// This census fails
//   1. a rule on a class named *-menu that declares its own surface (background, border, border-radius, box-shadow or padding), and
//   2. a script that writes the arrow-key index arithmetic again (a line with ArrowDown and a modulo), outside menu_keys.js,
// when it is not in fixtures/menu_looks_baseline.json: the count per file may not go up, and it must come down when a menu moves to the one menu (the message says "lower it"), so the list only shrinks.
// CORAL_UPDATE_ALLOWLIST=1 rewrites it (review the diff: a new entry is a new look).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fe = path.resolve(here, '../../coral-go/pkg/frontend/static');
const BASE = path.join(here, 'fixtures', 'menu_looks_baseline.json');
const blank = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
const SURFACE = /(?:^|;)\s*(background(?:-color)?|border(?:-top|-left|-right|-bottom)?|border-radius|box-shadow|padding)\s*:/;

export function scan() {
    const out = {};
    const add = (file, key) => { (out[file] ||= {})[key] = (out[file][key] || 0) + 1; };
    for (const f of fs.readdirSync(path.join(fe, 'css')).filter(n => n.endsWith('.css')).sort()) {
        const text = blank(fs.readFileSync(path.join(fe, 'css', f), 'utf8'));
        for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            if (!SURFACE.test(m[2])) continue;
            for (const raw of m[1].split(',')) {
                const last = raw.trim().split(/[\s>+~]+/).pop().split(':')[0];
                const cm = /^(?:[#.][\w-]+)*\.([\w-]*-menu)$/.exec(last);
                if (cm && cm[1] !== 'menu') add(`css/${f}`, `.${cm[1]}`);
            }
        }
    }
    for (const f of fs.readdirSync(fe).filter(n => n.endsWith('.js') && n !== 'menu_keys.js').sort()) {
        const lines = fs.readFileSync(path.join(fe, f), 'utf8').split('\n');
        for (const l of lines) if (/ArrowDown/.test(l) && /\)\s*%\s*[\w.]+\.length|%\s*(?:items|list|opts|options|rows|btns)\.length/.test(l)) add(f, 'arrow index arithmetic');
    }
    return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const got = scan();
    if (process.env.CORAL_UPDATE_ALLOWLIST) { fs.mkdirSync(path.dirname(BASE), { recursive: true }); fs.writeFileSync(BASE, JSON.stringify(got, null, 2) + '\n'); console.log('baseline written: ' + Object.keys(got).length + ' files'); process.exit(0); }
    const want = JSON.parse(fs.readFileSync(BASE, 'utf8'));
    const problems = [];
    for (const [f, keys] of Object.entries(got)) for (const [k, n] of Object.entries(keys)) { const w = (want[f] || {})[k] || 0; if (n > w) problems.push(`${f}: "${k}" is used ${n} times, the list has ${w}: a menu looks like the one menu (.menu, .menu-item, menu_keys.js), or it is a new look`); }
    for (const [f, keys] of Object.entries(want)) for (const [k, w] of Object.entries(keys)) { const n = (got[f] || {})[k] || 0; if (n < w) problems.push(`${f}: "${k}" is used ${n} times, the list still has ${w}: lower it (CORAL_UPDATE_ALLOWLIST=1 rewrites the list; review the diff)`); }
    assert.deepEqual(problems, [], problems.join('\n  '));
    const total = Object.values(want).reduce((a, k) => a + Object.values(k).reduce((x, y) => x + y, 0), 0);
    console.log(`menu_census: ok (${total} menu looks still to move, none new)`);
}
