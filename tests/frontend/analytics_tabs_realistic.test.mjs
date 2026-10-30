// What the three Analytics tabs make of the replies of a realistic synthetic board (#11291). The fixture is written by TestEveryAnalyticsNumberMatchesADirectCountOnARealisticBoard (Go), which seeds
// twelve agents, the Operator, Coral's notices, relays to and from two other boards, goal requests, tasks, asks and a month of token usage into a temporary database, checks the read against its own
// ledger and against SQL counts, and writes the replies with the ledger. Here: the rows the tabs draw are checked against that ledger. node analytics_tabs_realistic.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as D from '../../coral-go/pkg/frontend/static/analytics_tabs_data.js';

const fix = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'analytics_realistic.json'), 'utf8'));
const a = fix.activity.activity, e = fix.expect;
const rows = [];
const check = (name, want, got) => { assert.deepEqual(got, want, `${name}: the tab says ${JSON.stringify(got)}, a direct count says ${JSON.stringify(want)}`); rows.push([name, JSON.stringify(got)]); };

// ---- Operator interaction
const o = D.operatorModel(a);
check('Operator board posts', e.operator_posts, o.posts);
check('Posts per task done', D.perTaskWords(e.operator_posts, e.done), D.perTaskWords(o.posts, o.tasksDone));
check('Tasks done in the period', e.done, o.tasksDone);
check('Asks to the Operator', e.operator_asks[0], o.asks.asked);
check('  answered', e.operator_asks[1], o.asks.answered);
check('Median wait for an answer', D.fmtWait(e.operator_asks[2]), D.waitWords(o.asks, 'median_s'));
check('Slowest wait', D.fmtWait(e.operator_slowest), D.waitWords(o.asks, 'slowest_s'));
const need = Object.fromEntries(o.agents.map(g => [g.name, g.toOperator]));
for (const [name, n] of Object.entries(e.to_operator)) check('@mentions of the Operator by ' + name, n, need[name] || 0);
check('Touches (all kinds): the recording is on and the seed made no touch, so only the posts count', e.operator_posts, o.touches);
const tr = D.autonomyTrend(o.days), days = a.days;
const want = days.slice(6).map((_, k) => { const w = days.slice(k, k + 7), tasks = w.reduce((n, d) => n + d.tasks_done, 0), t = w.reduce((n, d) => n + d.operator, 0); return tasks > 0 ? t / tasks : null; });
check('Autonomy: touches per task done over 7 days, a point a day', want, tr.points.map(p => p.value));

// ---- Team communication
const c = D.commModel(a);
check('Messages by agents', e.agent_posts, c.kpis.agent);
check('automated notices counted apart', e.automated, c.kpis.automated);
check('With other teams', e.cross, c.kpis.cross);
check('Tasks handed to another agent', e.assigned, c.kpis.assigned);
check('Per task done', D.perTaskWords(e.agent_posts, e.done), D.perTaskWords(c.kpis.agent, c.kpis.tasksDone));
check('Median reply to an ask', D.fmtWait(e.agent_asks[2]), D.waitWords(c.kpis.asks, 'median_s'));
const sent = Object.fromEntries(c.agents.map(g => [g.name, [g.sent, g.received]]));
for (const name of Object.keys(e.sent)) check('Sent and received by ' + name, [e.sent[name], e.received[name] || 0], sent[name]);
check('Sent adds up to the messages', e.agent_posts, c.agents.reduce((n, g) => n + g.sent, 0));
const grid = c.cells.flat().reduce((n, v) => n + v, 0), top = new Set(c.names);
check('The grid adds up to the @mentions between its agents', a.edges.filter(x => top.has(x.from) && top.has(x.to)).reduce((n, x) => n + x.count, 0), grid);
check('Every @mention pair is in the read', e.edge_count, a.edges.length);
check('Messages a day add up to the messages by agents', e.agent_posts, c.days.reduce((n, d) => n + d.values.posts, 0));
check('Messages a day with other teams', e.cross, c.days.reduce((n, d) => n + d.values.cross, 0));
check('Automated notices a day', e.automated, c.days.reduce((n, d) => n + d.values.automated, 0));
const pg = c.pairs, got = Object.fromEntries(pg.rows.map(r => [r.from + '>' + r.to, [r.messages, r.requests, r.accepted]]));
check('Across teams: a row a pair, with its messages, goal requests and accepted', e.pairs, got);
check('Across teams: the grid adds up to messages plus requests', Object.values(e.pairs).reduce((n, p) => n + p[0] + p[1], 0), pg.total);

// ---- Usage: the spend of the 14 days and the 14 before, from the daily series
const u = D.usageModel(fix.timeseries.buckets, { days: 14, metric: 'cost', today: fix.today });
assert.ok(Math.abs(u.cur.cost - e.usage.cost_cur) < 1e-6, `Spend: ${u.cur.cost} against ${e.usage.cost_cur}`); rows.push(['Spend', D.fmtMoney(u.cur.cost)]);
assert.ok(Math.abs(u.prev.cost - e.usage.cost_prev) < 1e-6, `Spend before: ${u.prev.cost} against ${e.usage.cost_prev}`);
check('Tokens (input plus output)', e.usage.tokens_cur, u.cur.tokens);
check('Requests', e.usage.requests_cur, u.cur.requests);
assert.ok(Math.abs(u.rows.reduce((n, r) => n + r.total, 0) - e.usage.cost_cur) < 1e-6, 'the bars add up to the spend');
check('A bar a day', 14, u.rows.length);
assert.ok(u.series.length <= 8 && u.series.every(s => s.name), 'the legend names every series (at most 7 and Other)');

console.log('PASS analytics_tabs_realistic: ' + rows.length + ' figures, each equal to a direct count');
if (process.env.ANALYTICS_COMPARISON) console.log(rows.map(r => `${r[0]}: ${r[1]}`).join('\n'));
