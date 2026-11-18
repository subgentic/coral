// #19139: Dismiss, Save and Unsave on a file with earlier versions are ONE Activity row: every call made for an earlier version carries older_version (the server writes no row for it); the newest version's call does not.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../coral-go/pkg/frontend/static/artifact_review.js', import.meta.url), 'utf8');
test('the calls for earlier versions say so, the call for the newest does not', () => {
    const lines = src.split('\n').filter(l => l.includes('onEarlier(row, e => decide('));
    assert.ok(lines.length >= 3, 'ignore, save and unsave each settle the earlier versions');
    for (const l of lines) assert.match(l, /onEarlier\(row, e => decide\(e\.team, e, '\w+', undefined, undefined, false, '', true\)\)/, 'an earlier version is sent with older_version: ' + l.slice(0, 90));
    assert.match(src, /older_version: true/, 'decide() puts older_version in the body');
    assert.ok(!/await decide\(team, row, '(ignore|save|unsave)', [^)]*true\)/.test(src), 'the newest version never carries it');
});
