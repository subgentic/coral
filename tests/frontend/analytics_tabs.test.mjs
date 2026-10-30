// The rows the Analytics tabs Usage, Operator interaction and Team communication draw (#11222): pure functions of a read. node analytics_tabs.test.mjs
import assert from 'node:assert/strict';
import * as D from '../../coral-go/pkg/frontend/static/analytics_tabs_data.js';

// ---- Usage: 2n daily buckets become n days now and n before, the top 7 series and "Other"
const bucket = (day, series) => ({ bucket: `${day}T00:00:00Z`, cost_usd: series.reduce((n, s) => n + s[1], 0), input_tokens: 100, output_tokens: 50, cache_read_tokens: 1000, num_requests: 4, series: series.map(([key, c]) => ({ key, label: key.toUpperCase(), cost_usd: c, input_tokens: 10, output_tokens: 5, num_requests: 1 })) });
const many = Array.from({ length: 9 }, (_, i) => [`a${i}`, 9 - i]);
const u = D.usageModel([bucket('2026-10-28', [['a0', 1]]), bucket('2026-10-29', many), bucket('2026-10-30', [['a0', 2]])], { days: 2, metric: 'cost', today: '2026-10-30' });
assert.deepEqual(u.rows.map(r => r.day), ['2026-10-29', '2026-10-30'], 'the current days, a day with a read each');
assert.equal(u.series.length, 8, 'the top 7 and Other');
assert.equal(u.series.at(-1).name, 'Other (2)');
assert.equal(u.rows[0].values.__other, 1 + 2, 'the two smallest series are Other');
assert.equal(u.cur.cost, 45 + 2, 'the current total');
assert.equal(u.prev.cost, 1, 'the days before are the comparison');
assert.equal(u.busiest.day, '2026-10-29');
assert.equal(D.usageModel([], { days: 7, metric: 'cost', today: '2026-10-30' }).empty, true, 'nothing spent is said, not drawn as zeros');
assert.equal(D.usageModel([bucket('2026-10-30', [['a', 3]])], { days: 1, metric: 'tokens', today: '2026-10-30' }).rows[0].total, 15, 'tokens are input plus output; cache reads are not inside');
assert.equal(D.usageModel([bucket('2026-10-30', [['a', 3]])], { days: 1, metric: 'tokens', today: '2026-10-30' }).cur.cacheRead, 1000);
const rank = D.dayRanking(u.rows[0], u.series, 'cost');
assert.equal(rank[0].name, 'A0'); assert.ok(Math.abs(rank.reduce((n, r) => n + r.share, 0) - 1) < 1e-9, 'shares add up to the day');

// ---- Operator: a figure the read does not carry is "not recorded", never zero
const act = { days: [{ day: '2026-10-29', operator: 3 }, { day: '2026-10-30', operator: 1 }], tasks_done: 2, operator_asks: { asked: 2, answered: 1, median_s: 60, slowest_s: 60 }, agents: [{ name: 'A', to_operator: 2, asks_operator: 1 }, { name: 'B', to_operator: 0, asks_operator: 0 }] };
const o = D.operatorModel(act);
assert.equal(o.recorded, false); assert.deepEqual(o.kinds.map(k => k.key), ['posts']);
assert.deepEqual(o.agents.map(g => g.name), ['A'], 'an agent that never needed the Operator is not listed');
const o2 = D.operatorModel({ ...act, touches: { kinds: {}, days: [{ day: '2026-10-29', typed: 5, approve: 1 }], agents: [{ name: 'B', typed: 7 }] } });
assert.equal(o2.recorded, true); assert.equal(o2.touches, 3 + 1 + 5 + 1, 'posts plus every recorded kind'); assert.equal(o2.agents[0].name, 'B', 'typed touches rank an agent');
assert.equal(D.operatorModel({}).perTask, null);

// ---- Communication
const c = D.commModel({ agent_posts: 6, tasks_done: 3, edges: [{ from: 'A', to: 'B', count: 4 }, { from: 'B', to: 'A', count: 1 }], agents: [{ name: 'A', sent: 4, received: 1 }, { name: 'B', sent: 1, received: 4 }, { name: 'Idle', sent: 0, received: 0 }], days: [{ day: '2026-10-30', posts: 6, cross: 1, automated: 9 }] });
assert.deepEqual(c.names, ['A', 'B'], 'agents with no traffic are not in the grid'); assert.deepEqual(c.cells, [[0, 4], [1, 0]]);
assert.equal(c.kpis.perTask, 2); assert.equal(c.tasks, null, 'per-task counts that are not sent are "not recorded yet"');
assert.deepEqual(D.commModel({ agent_posts: 1, task_messages: [] }).tasks, [], 'an empty list is recorded, with no rows');
assert.equal(D.commModel({}).empty, true);
assert.equal(D.dayLabel('2026-10-05'), 'Oct 5'); assert.equal(D.fmtWait(7300), '2 h 02 min'); assert.equal(D.fmtCount(18200000), '18.2M'); assert.equal(D.fmtMoney(412.4), '$412');
console.log('PASS analytics_tabs: usage, operator and communication rows');
