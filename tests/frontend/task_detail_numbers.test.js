// A number in a task's detail is written as a number (Security's #7724 read): a server other than this one may send text in dep.task_id or request_count, and neither is escaped by its own helper.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../coral-go/pkg/frontend/static/task_detail_html.js'), 'utf8');
const start = source.indexOf('function _taskDetailHeadHtml(');
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const context = vm.createContext({
  escapeHtml: escape, escapeAttr: escape, _priorityRank: {}, formatTaskDate: String, _verifyLine: () => '', whenWords: String,
  _getBoardProject: () => 'p', boardKeyName: String, keyLabel: String, identityKey: String, splitKey: () => ({ server: '' }),
  formatCost: String, _formatTokenCount: String, _priorityLabel: String, _claimedFor: () => '', serverUrl: String, artifactPath: String, contextServer: () => '',
});
vm.runInContext(source.slice(start).replaceAll('export function', 'function'), context);
const evil = '<img src=x onerror=bad()>';
const task = { id: 1, title: 'T', status: 'pending', blocked_by: [{ task_id: evil, status: 'pending', board_id: 'p', title: 'dep' }, { task_id: 7, status: 'completed', board_id: 'p' }] };
let html = context._taskBlockedByHtml(task);
assert.ok(!html.includes('<img'), 'a dependency id that is text is not markup');
assert.ok(html.includes('#7'), 'a real id is still shown');
html = context._taskLiveCostHtml({ cost_usd: 0.5, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, request_count: evil });
assert.ok(!html.includes('<img'), 'a request count that is text is not markup');
html = context._taskLiveCostHtml({ cost_usd: 0.5, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, request_count: 12 });
assert.ok(html.includes('>12<'), 'a real count is still shown');
console.log('PASS task detail numbers are numbers');
