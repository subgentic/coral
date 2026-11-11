// The Getting started guide says its screenshots show the dark theme (#15175, walk 7 L17; the Orchestrator's decision: keep them dark and say so), once, near the top, before the first screenshot.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const md = readFileSync(new URL('../../coral-go/pkg/frontend/static/guide/getting-started.md', import.meta.url), 'utf8');
const caption = md.indexOf('Screenshots show the dark theme.'), firstShot = md.indexOf('![');
assert.ok(firstShot > 0, 'the guide has screenshots');
assert.ok(caption > 0 && caption < firstShot, 'the caption comes before the first screenshot');
assert.equal(md.split('Screenshots show the dark theme.').length - 1, 1, 'said once');
console.log('guide_theme_caption: ok');
