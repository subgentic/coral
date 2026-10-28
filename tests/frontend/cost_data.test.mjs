// The Analytics page's rows and range, pure (#8359, from #8340's census): what each period asks for and what each table's rows are made of, pinned on fixed input so the move out of cost_dashboard.js stays a move.
import assert from 'node:assert/strict';
import { costRange, providerRows, modelRows, thinkingRows, agentRows } from '../../coral-go/pkg/frontend/static/cost_data.js';

// the range a period names
const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const day = costRange('day', NOW);
assert.deepEqual(day, { hoursAgo: 24, since: '2026-10-25T12:00:00.000Z', sinceParam: '?since=2026-10-25T12%3A00%3A00.000Z', interval: '1h', tsParams: '?since=2026-10-25T12%3A00%3A00.000Z&interval=1h' });
assert.deepEqual(costRange('hour', NOW), { hoursAgo: 1, since: '2026-10-26T11:00:00.000Z', sinceParam: '?since=2026-10-26T11%3A00%3A00.000Z', interval: '5m', tsParams: '?since=2026-10-26T11%3A00%3A00.000Z&interval=5m' });
assert.equal(costRange('week', NOW).hoursAgo, 168); assert.equal(costRange('week', NOW).interval, '1h');
assert.equal(costRange('month', NOW).hoursAgo, 720); assert.equal(costRange('month', NOW).interval, '1d');
assert.deepEqual(costRange('all', NOW), day, 'there is no all-time period (the page offers four): a name it does not know is the day, as before (#8366 dropped the dead entry)');
assert.deepEqual(costRange('nonsense', NOW), day, 'an unknown period is the day');

// each table's rows
assert.deepEqual(providerRows([{ agent_type: 'claude', num_requests: 7, input_tokens: 100, output_tokens: 10, cache_read_tokens: 5, cache_write_tokens: 2, cost_usd: 1.5 }, {}]),
    [{ agent_type: 'claude', requests: 7, input_tokens: 100, output_tokens: 10, cache_read_tokens: 5, cache_write_tokens: 2, cost_usd: 1.5, cost_pct: 0 },
     { agent_type: 'unknown', requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, cost_pct: 0 }]);
assert.deepEqual(providerRows(undefined), [], 'no rows is no rows');
const m = modelRows([{ model: 'claude-opus-5-5', agent_type: 'claude', num_requests: 3, input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, cost_usd: 0.25 }, {}]);
assert.equal(m[0].model_id, 'claude-opus-5-5'); assert.equal(m[0].agent_type, 'claude'); assert.equal(m[0].requests, 3); assert.equal(m[0].cost_usd, 0.25);
assert.deepEqual(m[1], { model: 'unknown', model_id: '', agent_type: 'unknown', requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 });
const t = thinkingRows([{ agent_type: 'claude', model: 'claude-opus-5-5', num_calls: 4, thinking: 'xhigh', thinking_tokens: 99, input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, cost_usd: 0.5 }, { agent_type: 'codex', thinking: '', thinking_tokens: 7 }]);
assert.equal(t[0].level, 'Extra high'); assert.equal(t[0].level_key, 'xhigh'); assert.equal(t[0].requests, 4); assert.equal(t[0].thinking_tokens, 99); assert.equal(t[0].model_id, 'claude-opus-5-5');
assert.equal(t[1].level, 'Not reported'); assert.equal(t[1].level_key, ''); assert.equal(t[1].model, 'Not reported'); assert.equal(t[1].thinking_tokens, null, 'tokens shown only for a recorded level');
assert.equal(thinkingRows([{ thinking: 'mystery' }])[0].level, 'mystery', 'a level it has no name for is shown as it is');
const a = agentRows([{ session_id: 's1', agent_name: 'alpha', board_name: 'team-a', folder: 'work', working_dir: '/w', requests: 2, input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.1, first_seen: 'a', last_seen: 'b', launched_at: 'c', stopped_at: 'd' }, { session_id: 's2' }]);
assert.deepEqual(a[0], { session_id: 's1', agent_name: 'alpha', display_name: 'alpha', board_name: 'team-a', folder: 'work', working_dir: '/w', requests: 2, input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.1, first_seen: 'a', last_seen: 'b', launched_at: 'c', stopped_at: 'd', context_pct: null });
assert.equal(a[1].display_name, 'Agent'); assert.equal(a[1].board_name, ''); assert.equal(a[1].launched_at, '');
// #10272: an agent with no name on record is called by its folder, never "Agent"; the live agents that sent nothing in the range are listed at $0.00; a live agent shows its context used.
const u = agentRows([{ session_id: 's3', agent_name: '', folder: 'a2', cost_usd: 1 }]);
assert.equal(u[0].display_name, 'a2', 'the folder names an unnamed agent'); assert.equal(u[0].agent_name, 'a2', 'and is the key the chart groups it by');
const live = [{ session_id: 's3', name: 'a2', display_name: '', agent_type: 'claude', working_directory: '/w/a2', context_pct: 42, created_at: '2026-10-28T10:00:00Z' }, { session_id: 's9', name: 'quiet', display_name: 'Quiet one', agent_type: 'codex', working_directory: '/w/quiet', context_pct: null, created_at: '2026-10-28T11:00:00Z' }];
const w = agentRows([{ session_id: 's3', agent_name: '', folder: 'a2', cost_usd: 1 }], live);
assert.equal(w.length, 2, 'the live agent with no usage is a row'); assert.equal(w[0].context_pct, 42, 'a live agent carries its context used');
assert.deepEqual([w[1].session_id, w[1].display_name, w[1].cost_usd, w[1].requests, w[1].folder, w[1].is_live, w[1].context_pct], ['s9', 'Quiet one', 0, 0, 'quiet', true, null], 'at $0.00 with no requests');
assert.equal(agentRows([{ session_id: 's3', agent_name: 'x' }], live.slice(0, 1)).length, 1, 'a live agent that has a row is not listed twice');
console.log('cost_data: ok');
