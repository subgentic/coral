// #9100: the Analytics By task table asks the server for what it draws, not for the whole rows of 100 tasks every 15 s (147 K). The read
// is GET /api/board/tasks?has_cost=true&limit=100&fields=...: this pins that it stays narrow (no body or completion message, the filter
// on) and that every field it names is one the task query documents (agent_docs/board.md), so a renamed field fails here and not as a 400.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = fs.readFileSync(path.join(here, '../../coral-go/pkg/frontend/static/cost_dashboard.js'), 'utf8').replace(/\r\n/g, '\n');
const docs = fs.readFileSync(path.join(here, '../../coral-go/agent_docs/board.md'), 'utf8').replace(/\r\n/g, '\n');
const team = fs.readFileSync(path.join(here, '../../coral-go/pkg/frontend/static/team_page.js'), 'utf8');

const read = dashboard.match(/const COST_TASK_QUERY = `\?([^`]*)`/);
assert.ok(read && dashboard.includes("fetch('/api/board/tasks' + COST_TASK_QUERY)"), 'the dashboard reads /api/board/tasks with that query');
assert.match(read[1], /(^|&)has_cost=true(&|$)/, 'only the tasks that have a cost');
assert.match(read[1], /(^|&)limit=100(&|$)/);
const fields = (dashboard.match(/const COST_TASK_FIELDS = '([^']+)'/) || [])[1];
assert.ok(fields, 'the fields are named');
const names = fields.split(',');
assert.ok(!names.includes('body') && !names.includes('completion_message'), 'no long text');
const row = docs.split('\n').find(l => l.startsWith('| `fields`'));
for (const n of names) assert.ok(row.includes('`' + n + '`'), `${n} is a documented task query field`);
assert.match(docs, /\| `has_cost` \|/, 'has_cost is documented');
for (const n of ['cost_usd', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'claimed_at', 'completed_at', 'assigned_to', 'priority', 'status', 'title', 'board_id', 'id']) assert.ok(names.includes(n), `the table draws ${n}`);
assert.ok(!/fetch\('\/api\/board\/tasks'\)/.test(dashboard), 'no plain read of every task');
assert.ok(team.includes("boardFetch(team, '/tasks?counts=1')") && !team.includes("'/tasks?limit=1'"), 'the team page counts read the totals alone');
console.log('analytics_task_read: ok');
