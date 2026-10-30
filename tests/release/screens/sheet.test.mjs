import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { thumbnail, buildSheet } from './sheet.mjs';
import { buildManifest } from './manifest.mjs';

const png = (w, h, c = [30, 30, 30]) => { const p = new PNG({ width: w, height: h }); for (let i = 0; i < w * h; i++) p.data.set([...c, 255], i * 4); return PNG.sync.write(p); };

test('a thumbnail is a smaller PNG as a data URI', () => {
    const uri = thumbnail(png(1440, 900), 320);
    assert.match(uri, /^data:image\/png;base64,/);
    const out = PNG.sync.read(Buffer.from(uri.split(',')[1], 'base64'));
    assert.equal(out.width, 320);
    assert.equal(out.height, 200);
    assert.deepEqual([...out.data.slice(0, 4)], [30, 30, 30, 255]);
    assert.equal(PNG.sync.read(Buffer.from(thumbnail(png(200, 100), 320).split(',')[1], 'base64')).width, 200, 'never scaled up');
});

test('the sheet puts the changed pages first, folds the unchanged, links every image and escapes text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screens-sheet-'));
    try {
        const put = (file, buf) => { fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true }); fs.writeFileSync(path.join(tmp, file), buf); };
        const files = ['home__1440', 'team__1440', 'docs__1440'];
        for (const f of files) put(`dark/${f}.png`, png(400, 300));
        put('diff/dark/team__1440.png', png(400, 300, [250, 0, 0]));
        const results = files.map(f => ({ id: f.split('__')[0], width: '1440', theme: 'dark', file: `dark/${f}.png`, ok: true, sha: f.length.toString(16).padStart(64, '0'), notes: f.startsWith('docs') ? '<script>alert(1)</script>' : '' }));
        const changes = [{ file: 'dark/home__1440.png', status: 'unchanged', diffPixels: 2 }, { file: 'dark/team__1440.png', status: 'changed', diffPixels: 9000, diff: 'diff/dark/team__1440.png' }, { file: 'dark/docs__1440.png', status: 'unchanged', diffPixels: 0 }];
        const m = buildManifest({ version: '2.0.7', sha: 'abcdef0123456789', ranAt: '2026-10-30T12:00:00Z', widths: ['1440'], themes: ['dark'], results, changes });
        const links = { 'team__1440.png': 'coral://artifacts/' + 'e'.repeat(64), 'home__1440.png': 'coral://artifacts/' + 'f'.repeat(64), 'docs__1440.png': 'coral://artifacts/' + '1'.repeat(64) };
        const html = buildSheet({ manifest: m, links, dir: tmp, prevDir: null });
        assert.match(html, /<title>UI review v2\.0\.7<\/title>/);
        assert.ok(html.indexOf('Changed since the last release (1)') < html.indexOf('Unchanged (2)'));
        assert.ok(html.indexOf('id="team"') < html.indexOf('Unchanged (2)'), 'the changed page is in the first section');
        assert.equal((html.match(/id="home"/g) || []).length, 0, 'an unchanged page is folded into the list, not a card');
        assert.match(html, /<a href="coral:\/\/artifacts\/e{64}"><img/);
        assert.match(html, /diff 1440 \(9000 px\)/);
        assert.match(html, new RegExp(`<a href="coral://artifacts/${'f'.repeat(64)}">1440</a>`));
        assert.ok(!html.includes('<script>alert'), 'text from a page entry is escaped');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('with no earlier run every page is a card and the sheet says it is the baseline', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screens-sheet-'));
    try {
        fs.mkdirSync(path.join(tmp, 'dark'));
        fs.writeFileSync(path.join(tmp, 'dark/home__390.png'), png(390, 844));
        const m = buildManifest({ version: '2.0.6', sha: 'x', ranAt: 't', widths: ['390'], themes: ['dark'], results: [{ id: 'home', width: '390', theme: 'dark', file: 'dark/home__390.png', ok: true, sha: '0'.repeat(64) }], changes: null });
        const html = buildSheet({ manifest: m, links: {}, dir: tmp, prevDir: null });
        assert.match(html, /baseline for the next one/);
        assert.match(html, /id="home"/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
