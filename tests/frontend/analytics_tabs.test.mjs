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
assert.equal(o2.typed, 5, 'the typed touches of the period'); assert.equal(D.operatorModel(act).typed, null, 'no recording: not 0');
assert.equal(o2.recorded, true); assert.equal(o2.touches, 3 + 1 + 5 + 1, 'posts plus every recorded kind'); assert.equal(o2.agents[0].name, 'B', 'typed touches rank an agent');
assert.equal(o2.hub, 0, 'no Hub share when the read has no sources');
assert.equal(D.operatorModel({ ...act, touches: { days: [], agents: [], sources: { local: 4, hub: 3 } } }).hub, 3, 'the touches made through Coral Hub are counted as such');
assert.equal(D.operatorModel({}).perTask, null);

// ---- Communication
const c = D.commModel({ agent_posts: 6, tasks_done: 3, edges: [{ from: 'A', to: 'B', count: 4 }, { from: 'B', to: 'A', count: 1 }], agents: [{ name: 'A', sent: 4, received: 1 }, { name: 'B', sent: 1, received: 4 }, { name: 'Idle', sent: 0, received: 0 }], days: [{ day: '2026-10-30', posts: 6, cross: 1, automated: 9 }] });
assert.deepEqual(c.names, ['A', 'B'], 'agents with no traffic are not in the grid'); assert.deepEqual(c.cells, [[0, 4], [1, 0]]);
assert.equal(c.kpis.agent, 6); assert.equal(c.kpis.tasksDone, 3); assert.equal(D.perTaskWords(c.kpis.agent, c.kpis.tasksDone), '2.0'); assert.equal(c.tasks, null, 'per-task counts that are not sent are "not recorded yet"');
assert.deepEqual(D.commModel({ agent_posts: 1, task_messages: [] }).tasks, [], 'an empty list is recorded, with no rows');
assert.equal(D.commModel({ agent_posts: 0 }).empty, true, 'a read that counted no messages says so');
assert.equal(D.commModel({}).empty, false, 'a read with no counts at all is not "nothing was written": its figures are not recorded');
assert.equal(D.commModel({}).kpis.agent, null);
assert.equal(D.dayLabel('2026-10-05'), 'Oct 5'); assert.equal(D.fmtWait(7300), '2 h 02 min'); assert.equal(D.fmtCount(18200000), '18.2M'); assert.equal(D.fmtMoney(412.4), '$412');
// ---- a figure the read lacks says "not recorded yet", never 0 and never a dash; a recorded 0 is a 0
assert.equal(D.operatorModel({}).asks, null); assert.equal(D.operatorModel({}).posts, null);
assert.equal(D.countWords(null), 'not recorded yet'); assert.equal(D.countWords(0), '0', 'a recorded zero stays a zero');
assert.equal(D.waitWords(null, 'median_s'), 'not recorded yet'); assert.equal(D.waitWords({ asked: 0, answered: 0, median_s: null }, 'median_s'), 'No asks');
assert.equal(D.waitWords({ asked: 3, answered: 0, median_s: null }, 'median_s'), 'No answer yet'); assert.equal(D.waitWords({ asked: 3, answered: 2, median_s: 120, slowest_s: 300 }, 'slowest_s'), '5 min');
assert.equal(D.perTaskWords(null, 4), 'not recorded yet'); assert.equal(D.perTaskWords(8, null), 'not recorded yet'); assert.equal(D.perTaskWords(8, 0), 'No tasks done'); assert.equal(D.perTaskWords(9, 3), '3.0');
// ---- autonomy: touches per task done over a rolling 7 days; a window with no task has a gap, not a 0
const adays = Array.from({ length: 9 }, (_, i) => ({ day: `2026-10-${20 + i}`, label: `Oct ${20 + i}`, tasks: i === 0 || i === 1 ? 0 : 1, values: { posts: 2, typed: 1 } }));
const tr = D.autonomyTrend(adays);
assert.equal(tr.points.length, 3, 'one point a day from the 7th'); assert.equal(tr.points[0].value, 21 / 5, '7 days: 21 touches over 5 tasks'); assert.equal(tr.points[2].value, 21 / 7);
assert.equal(tr.last.label, 'Oct 28'); assert.equal(tr.enough, true);
const none = D.autonomyTrend(adays.map(d => ({ ...d, tasks: 0 })));
assert.deepEqual(none.points.map(p => p.value), [null, null, null], 'no task done in the window: a gap, not 0'); assert.equal(none.enough, false);
assert.equal(D.autonomyTrend(adays.slice(0, 5)).enough, false, 'under 7 days there is no trend');
// ---- team to team: messages plus goal requests, rows ask and columns are asked; no field is "not recorded", an empty list is "none"
const pg = D.pairGrid([{ from: 'alpha', to: 'beta', messages: 2, requests: 1, accepted: 1 }, { from: 'beta', to: 'alpha', messages: 1, requests: 0, accepted: 0 }, { from: 'alpha', to: 'gamma', messages: 1, requests: 0, accepted: 0 }]);
assert.deepEqual(pg.names, ['alpha', 'beta', 'gamma']); assert.equal(pg.cells[0][1], 3, 'alpha asked beta 2 messages and 1 request'); assert.equal(pg.cells[1][0], 1); assert.equal(pg.total, 5);
assert.equal(D.commModel({ agent_posts: 1 }).pairs, null, 'a read without pairs has not recorded them'); assert.deepEqual(D.commModel({ agent_posts: 1, pairs: [] }).pairs.rows, []);
console.log('PASS analytics_tabs: usage, operator and communication rows');

// Two teams of one name on two servers are two teams (QA #11294): alpha's local beta and homelab's beta do not merge into one cell or one row.
{
    const two = D.pairGrid([{ from: 'alpha', to: 'beta', messages: 2, requests: 0, accepted: 0 }, { from: 'alpha', to: 'beta', to_server: 'homelab', messages: 1, requests: 0, accepted: 0 }]);
    assert.deepEqual(two.names.sort(), ['alpha', 'beta', 'beta on homelab']);
    assert.equal(two.rows.length, 2);
    assert.deepEqual(two.rows.map(r => r.to).sort(), ['beta', 'beta on homelab']);
    assert.equal(two.total, 3);
    console.log('analytics_tabs: a team of the same name on another server is its own team ok');
}
