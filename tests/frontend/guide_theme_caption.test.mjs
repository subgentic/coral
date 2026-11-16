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
assert.match(md, /^# Getting started with Coral/m, 'the guide opens with its title');
console.log('guide_theme_caption: ok');
