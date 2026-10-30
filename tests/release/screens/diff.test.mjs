import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { compareImages, compareRuns } from './diff.mjs';

const image = (w, h, paint) => { const p = new PNG({ width: w, height: h }); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; const c = paint ? paint(x, y) : [20, 20, 20]; p.data.set([...c, 255], i); } return PNG.sync.write(p); };

test('identical images are unchanged', () => {
    const r = compareImages(image(200, 100), image(200, 100));
    assert.equal(r.changed, false);
    assert.equal(r.diffPixels, 0);
});

test('a few pixels (a clock) are below the bar; a moved block is a change', () => {
    const clock = (x, y) => (x < 10 && y < 10 ? [250, 250, 250] : [20, 20, 20]); // 100 pixels
    assert.equal(compareImages(image(400, 300), image(400, 300, clock)).changed, false);
    const block = (x, y) => (x > 100 && x < 200 && y > 100 && y < 160 ? [250, 40, 40] : [20, 20, 20]); // 6000 pixels
    const r = compareImages(image(400, 300), image(400, 300, block));
    assert.equal(r.changed, true);
    assert.ok(r.diffPixels > 5000 && r.diff);
});

test('a different size is a change, and the new rows count', () => {
    const r = compareImages(image(200, 100), image(200, 160));
    assert.equal(r.changed, true);
    assert.equal(r.sizeChanged, true);
    assert.ok(r.diffPixels >= 200 * 60 * 0.9);
});

test('runs: baseline with no earlier run, then changed, unchanged, new and removed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screens-diff-'));
    try {
        const put = (dir, file, buf) => { fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), buf); };
        const prev = path.join(tmp, 'prev'), cur = path.join(tmp, 'cur'), out = path.join(tmp, 'out');
        const block = (x, y) => (x > 50 && y > 50 ? [250, 40, 40] : [20, 20, 20]);
        put(prev, 'dark/home__1440.png', image(300, 200)); put(prev, 'dark/gone__1440.png', image(300, 200)); put(prev, 'dark/team__1440.png', image(300, 200));
        put(cur, 'dark/home__1440.png', image(300, 200)); put(cur, 'dark/team__1440.png', image(300, 200, block)); put(cur, 'dark/fresh__1440.png', image(300, 200));
        assert.deepEqual(compareRuns(null, cur, out).map(r => r.status), ['baseline', 'baseline', 'baseline']);
        const rows = Object.fromEntries(compareRuns(prev, cur, out).map(r => [r.file, r]));
        assert.equal(rows['dark/home__1440.png'].status, 'unchanged');
        assert.equal(rows['dark/team__1440.png'].status, 'changed');
        assert.ok(fs.existsSync(path.join(out, rows['dark/team__1440.png'].diff)), 'the diff image is written');
        assert.equal(rows['dark/fresh__1440.png'].status, 'new');
        assert.equal(rows['dark/gone__1440.png'].status, 'removed');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
