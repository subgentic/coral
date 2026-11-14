// #15933: a "WebSocket connection closed" failure is followed by what the runner saw of the shard's Chrome.
import assert from 'node:assert/strict';
import { wsCloseNote } from './helpers/ws_close_note.mjs';

const closed = 'Error: WebSocket connection closed\n    at Chrome._handleConnectionClose';
assert.equal(await wsCloseNote('PASS everything', 2, async () => { throw new Error('must not probe'); }), '', 'a suite that did not lose its socket gets no note');
let n = await wsCloseNote(closed, 2, async () => ({ exit: 'exit code null signal SIGKILL', pages: [], stderr: 'a\nb' }));
assert.match(n, /shard 2: the suite's CDP socket closed\. Chrome HAS EXITED \(exit code null signal SIGKILL\); 0 page\(s\) open\./);
assert.match(n, /Chrome stderr \(last lines\):\n    a\n    b/);
n = await wsCloseNote(closed, 1, async () => ({ exit: null, pages: ['http://127.0.0.1:1/inbox?x=1'], stderr: '' }));
assert.match(n, /Chrome is still running; 1 page\(s\) open: http:\/\/127\.0\.0\.1:1\/inbox\./);
assert.doesNotMatch(n, /stderr/);
n = await wsCloseNote(closed, 1, async () => ({ exit: null, pages: [], stderr: '[1:2:ERROR:ui/display/mac/cv_display_link_mac.mm:188] x\nTrying to load the allocator multiple times.\n' }));
assert.doesNotMatch(n, /stderr/, 'the two lines a headless Mac Chrome always prints are not Chrome speaking');
n = await wsCloseNote(closed, 3, async () => { throw new Error('connect ECONNREFUSED\nmore'); });
assert.match(n, /looking at Chrome failed: connect ECONNREFUSED$/);
console.log('PASS the runner says what became of Chrome when a suite loses its CDP socket');
