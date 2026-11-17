// The Getting started guide (#18825, the Technical Writer's v7, approved by the Operator) shows Coral in pictures: it has screenshots, every one is inline in the file (shipped with the binary, nothing fetched) and
// has words for a screen reader. (It said once that its screenshots were the dark theme, #15175; the new text has no such line and its pictures are the guide's own.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const md = readFileSync(new URL('../../coral-go/pkg/frontend/static/guide/getting-started.md', import.meta.url), 'utf8');
const shots = [...md.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)];
assert.ok(shots.length >= 5, 'the guide has screenshots: ' + shots.length);
for (const [, alt, src] of shots) {
    assert.ok(alt.trim().length > 8, 'a screenshot has words for a screen reader: "' + alt + '"');
    assert.match(src, /^data:image\//, 'a screenshot is inline, not fetched: ' + src.slice(0, 40));
}
// Every picture is sharp on a Retina screen (#19019, the Operator: "the resolution in the getting started images is very low"): the guide's column is about 756 px wide, so a picture needs at least twice that in pixels. The size is read from the file's own header.
function pixelWidth(uri) {
    const m = /^data:image\/(png|webp|jpeg);base64,(.*)$/s.exec(uri);
    assert.ok(m, 'a picture is a png, webp or jpeg: ' + uri.slice(0, 30));
    const b = Buffer.from(m[2].slice(0, 16000), 'base64');
    if (m[1] === 'png') return b.readUInt32BE(16);
    if (m[1] === 'webp') {
        const kind = b.toString('ascii', 12, 16);
        if (kind === 'VP8 ') return b.readUInt16LE(26) & 0x3fff;
        if (kind === 'VP8X') return 1 + b.readUIntLE(24, 3);
        if (kind === 'VP8L') return 1 + (b.readUInt32LE(21) & 0x3fff);
    }
    let i = 2; for (; i < b.length;) { if (b[i] === 0xff && b[i + 1] >= 0xc0 && b[i + 1] <= 0xc3) return b.readUInt16BE(i + 7); i += 2 + b.readUInt16BE(i + 2); }
    return 0;
}
for (const [, alt, src] of shots) assert.ok(pixelWidth(src) >= 1300, 'a picture is sharp on a 2x screen (at least 1300 px wide): ' + pixelWidth(src) + ' px, "' + alt.slice(0, 50) + '"');
assert.match(md, /^# Getting started with Coral/m, 'the guide opens with its title');
console.log('guide_theme_caption: ok');
