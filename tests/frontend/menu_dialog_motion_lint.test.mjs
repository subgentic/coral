// A menu, dialog, popover or overlay appears in 150 ms or less (#17242, walk 57 F10: they faded in over ~2 s on a phone). Looping animations are not appearances. prefers-reduced-motion
// already makes every animation instant (animations.css).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve(import.meta.dirname, '../../coral-go/pkg/frontend/static/css');
const slow = [];
for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = m[1].trim(); if (!/menu|dialog|modal|popover|overlay|dropdown|popup/i.test(sel)) continue;
        for (const d of m[2].matchAll(/(animation|transition)(?:-duration)?\s*:\s*([^;]+)/g)) {
            if (/infinite/.test(d[2])) continue;
            const secs = [...d[2].matchAll(/(\d*\.?\d+)(ms|s)\b/g)].map(x => Number(x[1]) * (x[2] === 's' ? 1 : 0.001));
            if (secs.length && Math.max(...secs) > 0.15 + 1e-9) slow.push(`${f}: ${sel.replace(/\s+/g, ' ').slice(0, 60)} { ${d[0].trim()} }`);
        }
    }
}
assert.deepEqual(slow, [], 'a menu, dialog or overlay that takes longer than 150 ms to appear');
console.log('PASS menu_dialog_motion_lint: no menu, dialog, popover or overlay takes longer than 150 ms to appear');
