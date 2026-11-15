import assert from 'node:assert/strict';
globalThis.location = { search: '' };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { createElement: () => ({ textContent: '', get innerHTML() {
    return this.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
} }) };
const { highlightExcerpt, isSearchResponseUsable } = await import('../../coral-go/pkg/frontend/static/chat_search.js');

assert.equal(isSearchResponseUsable('complete'), true);
assert.equal(isSearchResponseUsable('partial'), true);
assert.equal(isSearchResponseUsable('unavailable'), false);
assert.equal(isSearchResponseUsable('ok'), false);

// Offsets are UTF-16 code units from the search API. This also verifies that
// excerpts remain text even when a transcript contains HTML-looking content.
const excerpt = '<img src=x onerror=alert(1)> café';
const html = highlightExcerpt(excerpt, [[0, 5], [30, 34]]);
assert.match(html, /^<mark>&lt;img/);
assert.doesNotMatch(html, /<img\b/i);
assert.match(html, /afé/);

// Overlapping and out-of-range offsets must produce stable, escaped output.
const safe = highlightExcerpt('alpha beta', [[0, 5], [3, 8], [-2, 99]]);
assert.match(safe, /<mark>alpha<\/mark>/);
assert.match(safe, /beta/);
// The excerpt is shown as the words it says (walk 78, #17801): markdown marks (** __ ~~ backticks, a heading's #) are dropped and the match offsets, which count the raw text, follow the words.
const md = highlightExcerpt('Use **bold** and `code` here', [[6, 10], [18, 22]]);
assert.equal(md, 'Use <mark>bold</mark> and <mark>code</mark> here', md);
assert.equal(highlightExcerpt('## Plan\nthe **plan** holds', [[3, 7]]), '<mark>Plan</mark>\nthe plan holds');
assert.equal(highlightExcerpt('a **b', [[0, 1]]), '<mark>a</mark> b', 'a mark with no partner is dropped too');
assert.equal(highlightExcerpt('2 ** 3 = 8', [[9, 10]]), '2  3 = <mark>8</mark>', 'a stray pair is a mark: dropped (the words around it are intact)');
// A double underscore is emphasis only around words (#17912): snake__case and __init__ keep theirs, "__two words__" loses them and its match offsets follow.
assert.equal(highlightExcerpt('__init__ and snake__case', [[0, 8]]), '<mark>__init__</mark> and snake__case');
assert.equal(highlightExcerpt('a __two words__ b', [[4, 7]]), 'a <mark>two</mark> words b');
console.log('chat_search_unit: ok');
