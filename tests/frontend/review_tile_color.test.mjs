import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = name => readFileSync(new URL('../../coral-go/pkg/frontend/static/css/'+name, import.meta.url),'utf8');
const needs = css('needs_rows_compact.css'), activity = css('activity_ledger.css');
for (const type of ['html','video','md']) assert.ok(!needs.includes(`.inbox-kind-icon[data-type="${type}"] {`),type+' must inherit the review palette, never override it');
for (const type of ['html','video']) assert.ok(needs.includes(`[data-type="${type}"]:not(.inbox-artifact-thumbnail)::before`),type+' keeps its type artwork');
assert.match(needs,/\[data-kind="review"\].*background: var\(--needs-icon-blue-bg\)/);
assert.match(needs,/\[data-kind="permission"\].*background: var\(--needs-icon-amber-bg\)/);
assert.match(needs,/\[data-kind="run"\].*background: var\(--needs-icon-red-bg\)/);
assert.match(needs,/\.inbox-kind-icon\.inbox-artifact-thumbnail:has\(\.artifact-thumbnail-image\).*background: var\(--bg-tertiary\)/);
assert.match(activity,/\.al-tile-file, \.al-tile-image:not\(\.al-tile-thumb\).*background: var\(--needs-icon-blue-bg\)/);
assert.ok(!/^\.al-fk-.*\{/m.test(activity),'Activity files inherit one palette regardless of type');
assert.match(activity,/\.al-tile-thumb \{.*background: none;.*border-color: rgba\(var\(--success-rgb\), 0.3\)/,'Activity thumbnails keep their original surface and border');
console.log('review_tile_color: all review file types inherit blue; glyphs, thumbnails, permission amber and failed-run red stay');

assert.match(needs,/\.inbox-kind-icon\[data-kind="review"\].*svg \[stroke\].*stroke: currentColor/);
assert.match(needs,/\.inbox-kind-icon\[data-kind="review"\].*svg \[fill\].*fill: currentColor/);
