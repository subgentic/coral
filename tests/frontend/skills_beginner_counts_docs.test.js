// #17362: exercise the real Docs snippet function and artifact count hook with small inputs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../coral-go/pkg/frontend/static');
const docs = fs.readFileSync(path.join(root, 'docs.js'), 'utf8');
const start = docs.indexOf('function hitSentence(name)');
const end = docs.indexOf('/** What matched', start);
function snippet(raw) {
    return vm.runInNewContext(docs.slice(start, end) + '\nhitSentence("sample")', {
        queryWords: () => ['skill'], docRaw: new Map([['sample', raw]]),
        linesOf: () => [{text: raw, low: raw.toLowerCase(), noCode: raw.toLowerCase(), kind: 3}]
    });
}
assert.equal(snippet('| skill | search | get | list |'), 'skill search get list', 'table cells retain spaces');
assert.equal(snippet('Find a [skill](https://example.org/private-address) here.'), 'Find a skill here.', 'Markdown links show readable text without their URL');
const order = docs.match(/const GETTING_STARTED_ORDER = (\[[^;]+\]);/)[1];
assert.ok(vm.runInNewContext(order).includes('skills'), 'Skills belongs in Getting started');
const artifacts = fs.readFileSync(path.join(root, 'inbox_artifacts.js'), 'utf8');
const hookStart = artifacts.indexOf('const hooks = () =>');
const hookEnd = artifacts.indexOf('\n', hookStart);
const count = {textContent: '3'};
const hooks = vm.runInNewContext(artifacts.slice(hookStart, hookEnd) + '\nhooks()', {
    pageHost: {querySelector: selector => selector.includes('.session-group-count') ? count : null},
    document: { querySelector: selector => selector.includes('.session-group-count') ? count : null }, shownCount: null, count: 3, countAt: 0, onCount: () => {}, Date
});
assert.equal(typeof hooks.onShown, 'function', 'the rendered list reports its visible population');
hooks.onShown(1, 3, false);
assert.equal(count.textContent, '1 shown of 3', 'search shows visible count and total separately');
hooks.onCount(3);
assert.equal(count.textContent, '1 shown of 3', 'background total refresh cannot overwrite the filtered count');
hooks.onShown(0, 3, false);
assert.equal(count.textContent, '0 shown of 3', 'zero results remains distinct from three stored files');
hooks.onShown(20, 50, true);
assert.equal(count.textContent, '20+ shown of 50', 'pagination states that more rows exist');
console.log('PASS beginner Docs snippets and artifact population counts');
