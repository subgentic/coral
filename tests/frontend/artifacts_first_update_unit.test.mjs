// The page's first full update is its first sight of the artifact revisions, not a return after a gap: it announces nothing (a cold Inbox read every list twice when the socket answered late); the next one does (#21126).
import assert from 'node:assert/strict';
const feed = await import(new URL('../../coral-go/pkg/frontend/static/artifacts_feed.js', import.meta.url).href); // a file:// URL: a Windows path (D:\...) is not a valid import specifier (#21646)
const log = [];
feed.onArtifactsRev((...a) => log.push(a));
feed.publishArtifactsRev({ t: 5 }, true);
assert.equal(log.length, 0, 'the first full update announces nothing');
feed.publishArtifactsRev({ t: 5 }, false);
assert.equal(log.length, 0, 'the same revision again announces nothing');
feed.publishArtifactsRev({ t: 6 }, false);
assert.equal(log.length, 1, 'a new revision announces');
feed.publishArtifactsRev({ t: 6 }, true);
assert.equal(log.length, 3, 'a later full update (a return after a gap) announces the whole page and the team');
console.log('artifacts_first_update_unit: ok');
