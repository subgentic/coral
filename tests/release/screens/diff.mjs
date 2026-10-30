// Which pages changed since the last release: a pixel diff (pixelmatch) of each shot against the same shot of the previous version, kept in a cache folder outside the repo. The pixels decide, not a
// person or a model. A shot is "changed" when more than DIFF_PIXELS pixels differ (a time or a version number is a few hundred; a moved button or a new row is thousands), or when its size differs.
//   node diff.mjs --prev DIR --cur DIR --out DIR      writes <out>/changes.json and the diff images under <out>/diff/
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export const DEFAULTS = { threshold: 0.1, minPixels: Number(process.env.SCREENS_DIFF_PIXELS || 300), minRatio: Number(process.env.SCREENS_DIFF_RATIO || 0.0005) };

/** Compares two PNG buffers: { changed, diffPixels, ratio, sizeChanged, a: {w,h}, b: {w,h}, diff: PNG | null }. */
export function compareImages(bufA, bufB, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const a = PNG.sync.read(bufA), b = PNG.sync.read(bufB);
    const sizeChanged = a.width !== b.width || a.height !== b.height;
    const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
    const pad = img => { // each image on a canvas of the larger size, the empty part transparent: a taller page differs in the new rows
        if (img.width === w && img.height === h) return img.data;
        const out = Buffer.alloc(w * h * 4);
        for (let y = 0; y < img.height; y++) img.data.copy(out, y * w * 4, y * img.width * 4, (y + 1) * img.width * 4);
        return out;
    };
    const diff = new PNG({ width: w, height: h });
    const diffPixels = pixelmatch(pad(a), pad(b), diff.data, w, h, { threshold: o.threshold, includeAA: false });
    const ratio = diffPixels / (w * h);
    const changed = sizeChanged || (diffPixels > o.minPixels && ratio > o.minRatio);
    return { changed, diffPixels, ratio, sizeChanged, a: { w: a.width, h: a.height }, b: { w: b.width, h: b.height }, diff: diffPixels ? diff : null };
}

/** Compares every shot of a run with the previous version's. A shot with no earlier one is "new"; an earlier one with no shot now is "removed". */
export function compareRuns(prevDir, curDir, outDir, opts = {}) {
    const list = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(t => fs.statSync(path.join(dir, t)).isDirectory() && t !== 'diff').flatMap(t => fs.readdirSync(path.join(dir, t)).filter(f => f.endsWith('.png')).map(f => `${t}/${f}`)) : []);
    const prev = new Set(prevDir ? list(prevDir) : []), cur = list(curDir);
    const rows = [];
    for (const file of cur) {
        if (!prevDir || !prev.has(file)) { rows.push({ file, status: prevDir ? 'new' : 'baseline' }); continue; }
        const r = compareImages(fs.readFileSync(path.join(prevDir, file)), fs.readFileSync(path.join(curDir, file)), opts);
        const row = { file, status: r.changed ? 'changed' : 'unchanged', diffPixels: r.diffPixels, ratio: Number(r.ratio.toFixed(6)), sizeChanged: r.sizeChanged, before: r.a, after: r.b };
        if (r.changed && r.diff) {
            const diffFile = path.join('diff', file);
            fs.mkdirSync(path.join(outDir, path.dirname(diffFile)), { recursive: true });
            fs.writeFileSync(path.join(outDir, diffFile), PNG.sync.write(r.diff));
            row.diff = diffFile;
        }
        rows.push(row);
    }
    for (const file of prev) if (!cur.includes(file)) rows.push({ file, status: 'removed' });
    return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
    const prev = arg('prev'), cur = arg('cur'), out = arg('out') || cur;
    if (!cur) { console.error('usage: diff.mjs [--prev DIR] --cur DIR [--out DIR]'); process.exit(2); }
    const rows = compareRuns(prev && fs.existsSync(prev) ? prev : null, cur, out);
    fs.writeFileSync(path.join(out, 'changes.json'), JSON.stringify({ prev: prev || null, rows }, null, 2));
    const n = s => rows.filter(r => r.status === s).length;
    console.error(`[diff] ${rows.length} shots: ${n('changed')} changed, ${n('unchanged')} unchanged, ${n('new')} new, ${n('removed')} removed, ${n('baseline')} baseline`);
}
