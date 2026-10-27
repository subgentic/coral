// One notice (Goal #88, spec item 3): a notice is `.notice` with a tone (.notice-info, -ok, -warn, -error), `.notice-bar` at a screen's edge, `.notice-float` over content, and the load and error line is `.notice-line` (layout.css).
// A page's own class (sched-fail-banner, tmux-missing-banner ...) says where it sits, never what a notice looks like. This census fails a rule on a class named *-banner, *-notice or *-toast that declares its own
// look (background, border, border-radius, box-shadow, padding, colour, font size or weight) when it is not in fixtures/notice_looks_baseline.json: the count per file may not go up, and it must come down when a
// notice moves to the one notice (the message says "lower it"), so the list only shrinks. CORAL_UPDATE_ALLOWLIST=1 rewrites it (review the diff: a new entry is a new look).
// A class that only draws a part of a notice (a -banner-icon, a -toast-title) is not matched: the census reads the last class of the selector, and only a class ending in -banner, -notice or -toast.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = path.resolve(here, '../../coral-go/pkg/frontend/static/css');
const BASE = path.join(here, 'fixtures', 'notice_looks_baseline.json');
const blank = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
const LOOK = /(?:^|;)\s*(background(?:-color|-image)?|border(?:-top|-left|-right|-bottom|-color)?|border-radius|box-shadow|padding|color|font-size|font-weight)\s*:/;

export function scan() {
    const out = {};
    for (const f of fs.readdirSync(css).filter(n => n.endsWith('.css')).sort()) {
        const text = blank(fs.readFileSync(path.join(css, f), 'utf8'));
        for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            if (!LOOK.test(m[2])) continue;
            for (const raw of m[1].split(',')) {
                const last = raw.trim().split(/[\s>+~]+/).pop().split(':')[0];
                const cm = /^(?:[#.][\w-]+)*\.([\w-]*-(?:banner|notice|toast))$/.exec(last);
                if (cm) (out[`css/${f}`] ||= {})[`.${cm[1]}`] = ((out[`css/${f}`] || {})[`.${cm[1]}`] || 0) + 1;
            }
        }
    }
    return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const got = scan();
    if (process.env.CORAL_UPDATE_ALLOWLIST) { fs.mkdirSync(path.dirname(BASE), { recursive: true }); fs.writeFileSync(BASE, JSON.stringify(got, null, 2) + '\n'); console.log('baseline written: ' + Object.keys(got).length + ' files'); process.exit(0); }
    const want = JSON.parse(fs.readFileSync(BASE, 'utf8'));
    const problems = [];
    for (const [f, keys] of Object.entries(got)) for (const [k, n] of Object.entries(keys)) { const w = (want[f] || {})[k] || 0; if (n > w) problems.push(`${f}: "${k}" declares its own look ${n} times, the list has ${w}: write a .notice (tone, bar, float) and keep only where it sits, or it is a new look`); }
    for (const [f, keys] of Object.entries(want)) for (const [k, w] of Object.entries(keys)) { const n = (got[f] || {})[k] || 0; if (n < w) problems.push(`${f}: "${k}" declares its own look ${n} times, the list still has ${w}: lower it (CORAL_UPDATE_ALLOWLIST=1 rewrites the list; review the diff)`); }
    assert.deepEqual(problems, [], problems.join('\n  '));
    const total = Object.values(want).reduce((a, k) => a + Object.values(k).reduce((x, y) => x + y, 0), 0);
    console.log(`notice_census: ok (${total} notice looks still to move, none new)`);
}
