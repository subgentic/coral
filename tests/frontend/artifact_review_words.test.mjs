// #136584 (Mobile Beta Tester, live): the preview of an approved artifact said it only as an "approved" tag chip; the review's state is said in words, with the time of an approval.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { reviewWords } = await importUi('artifact_tags');
const at = '2026-10-30T10:42:00Z';
assert.match(reviewWords(['approved', 'final'], { state: 'approved', at }), /^Approved .*2026.*|^Approved .+/, 'an approved artifact says Approved with its time');
assert.notEqual(reviewWords(['approved'], { state: 'approved', at }), 'Approved', 'and the time is in it');
assert.equal(reviewWords(['approved'], undefined), 'Approved', 'an approval with no recorded time says only Approved');
assert.equal(reviewWords(['for review'], undefined), 'Waiting for your review');
assert.equal(reviewWords(['for review', 'changes requested'], undefined), 'Changes requested');
assert.equal(reviewWords(['reviewed'], undefined), 'Reviewed');
assert.equal(reviewWords(['internal'], undefined), '');
assert.equal(reviewWords(undefined, undefined), '');
console.log('artifact_review_words: ok');
