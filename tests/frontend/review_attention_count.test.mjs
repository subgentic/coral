import assert from 'node:assert/strict';
import { reviewAttentionCount, setReviewCacheReader, setReviewCounter } from '../../coral-go/pkg/frontend/static/ask_filter.js';
const loaded = [{}, {}];
setReviewCacheReader(() => loaded, () => {}, () => ({ attentionTotal: 125 }));
assert.deepEqual(reviewAttentionCount(), { value: 125, complete: true }, 'an authoritative total is independent of the loaded window');
setReviewCacheReader(() => loaded, () => {}, () => ({ queryTotal: 125, attentionTotal: null }));
assert.deepEqual(reviewAttentionCount(), { value: 2, complete: false }, 'a raw query total cannot substitute for attention policy');
setReviewCacheReader(() => [], () => {}, () => ({ attentionTotal: 0 }));
assert.deepEqual(reviewAttentionCount(), { value: 0, complete: true }, 'explicit zero is a known total');
setReviewCacheReader(() => loaded, () => {});
assert.deepEqual(reviewAttentionCount(), { value: 2, complete: true }, 'legacy cache readers retain their old behavior');
console.log('review_attention_count: exact attention totals and incomplete loaded windows stay distinct');

setReviewCacheReader(() => loaded, () => {}, () => ({ attentionTotal: null, loadedBySource: { local: 2, remote: 3 } }));
setReviewCounter(() => 125, () => ({ complete: true, knownTotal: 125, sources: [{ server: 'local', total: 125 }] }));
assert.deepEqual(reviewAttentionCount(), { value: 125, complete: true }, 'known totals survive opening a short page');
setReviewCounter(() => null, () => ({ complete: false, knownTotal: 125, sources: [{ server: 'local', total: 125 }, { server: 'remote', total: null }] }));
assert.deepEqual(reviewAttentionCount(), { value: 128, complete: false }, 'only failed sources contribute their loaded lower bound, without double counting healthy sources');

setReviewCounter(() => 4, () => ({ complete: true, knownTotal: 4, sources: [{ server: 'local', total: 4 }] }));
for (const n of [2, 3, 0]) {
    setReviewCacheReader(() => loaded, () => {}, () => ({ attentionTotal: n, loadedBySource: { local: n } }));
    assert.deepEqual(reviewAttentionCount(), { value: n, complete: true }, 'a complete current page recounts muted, read and comment state without another summary request');
}
setReviewCacheReader(() => loaded, () => {}, () => ({ attentionTotal: null, loadedBySource: { local: 2 } }));
assert.deepEqual(reviewAttentionCount(), { value: 4, complete: true }, 'an incomplete page still uses the full server summary');
