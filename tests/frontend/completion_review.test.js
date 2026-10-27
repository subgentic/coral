// Pure rendering regression: use the production detail renderer without a DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../coral-go/pkg/frontend/static/task_detail_html.js'), 'utf8');
const start = source.indexOf('function _taskDetailHeadHtml('); // the detail is built by helpers (#4702): from the first of them to the end of _taskDetailHtml
const end = source.length; // the helpers run to the end of task_detail_html.js (moved out of tasks.js, #4996)
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const context = vm.createContext({ escapeHtml: escape, escapeAttr: escape, _priorityRank: {}, formatTaskDate: String, _verifyLine: () => '', whenWords: String }); // the detail's verification line (#4564) is drawn by tasks.js; none of these tasks has one
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../coral-go/pkg/frontend/static/review_pool.js'), 'utf8').replaceAll('export ', ''), context);
vm.runInContext(source.slice(start, end).replaceAll('export function', 'function'), context);
const candidate = { submitted_by: '<img src=x>', submitted_at: 'now', proposed_outcome: 'success', reason: 'Review <pending>', message: '<script>bad()</script>', artifacts: [{ name: 'build', content: '<img onerror=bad()>', revision: 'rev-42' }] };
const task = { id: 1, title: 'Build', status: 'in_progress', workflow: { completion_review: candidate } };
let html = context._taskDetailHtml(task, null);
assert.ok(html.includes('In progress · review requested'));
assert.ok(html.includes('not accepted yet'));
assert.ok(html.includes('rev-42'));
assert.ok(!html.includes('<script>') && !html.includes('<img'));
assert.ok(!html.includes('Completion artifacts'));
task.status = 'review_pending';
candidate.released_by = 'reviewer'; candidate.released_at = 'later'; candidate.release_reason = 'Independent work';
html = context._taskDetailHtml(task, null);
assert.ok(html.includes('In review'));
assert.ok(html.includes('Released by reviewer'));
assert.ok(!html.includes('Finished'));
task.status = 'completed'; task.workflow.outcome = 'failed';
html = context._taskDetailHtml(task, null);
assert.ok(html.includes('Finished') && html.includes('Failed'));
assert.ok(html.includes('not accepted yet'), 'candidate history remains distinct from final outcome');
console.log('PASS completion review labels, retained evidence, outcome distinction, and escaping');

// Pool status, partial assignment and current-round ownership; older review history must not name a stale reviewer.
task.status = 'review_pending';
Object.assign(task.workflow, {review_in_pool:true, review_areas:['ui','<img>'], reviewers_wanted:2, review_rounds:[{reviewers:[{reviewer:'Old'}]}, {reviewers:[{reviewer:'Ada <script>'}]}]});
html = context._taskDetailHtml(task, null);
assert.match(html, /In the pool/); assert.match(html, /1 of 2 reviewers assigned/);
assert.match(html, /Ada &lt;script&gt;/); assert.match(html, /Review areas: ui, &lt;img&gt;/);
assert.ok(!html.includes('Old') && !html.includes('<script>') && !html.includes('<img>'));
task.workflow.review_in_pool = false;
html = context._taskDetailHtml(task, null);
assert.match(html, /Reviewer: Ada/); assert.ok(!html.includes('Waiting for the Orchestrator'));
assert.equal(vm.runInContext("JSON.stringify(reviewAreas('UI, go,ui'))", context), '["ui","go"]');
assert.equal(context.reviewAreasError(''), '');
for (const bad of ['a/b', '9go', 'a'.repeat(25), 'a,b,c,d,e,f,g,h,i']) assert.ok(context.reviewAreasError(bad));
assert.equal(vm.runInContext("needsReview({status:'review_pending'})", context), true);
assert.equal(vm.runInContext("needsReview({status:'in_progress',review_requested:true})", context), false);
console.log('PASS review pool areas, validation, assignment and escaping');
