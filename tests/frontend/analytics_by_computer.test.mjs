// #16017 (the Operator's ask, 2026-11-12): the Overview has a "By computer" table: this computer and each linked one, with cost, input and output tokens, agents and requests, read from each computer. A computer that does
// not answer shows its last figures and when it was last seen, never a zero; one never read has no figures and says so; the total is the sum of the rows shown. Stubbed GET /api/token-usage/summary, jsdom.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { state } = await importUi('state');
const mod = await importUi('analytics_servers');
const { figuresOf, costUnits, showUnits, breakdown, showByComputer, forgetReads } = mod;

// ── the figures of an answer: a malformed one is a failed read, never zeros ──
assert.deepEqual(figuresOf({ totals: { input_tokens: 10, output_tokens: 20, num_sessions: 2, num_requests: 7, cost_usd: 1.234 } }), { cost: 12300, input: 10, output: 20, agents: 2, requests: 7 });
for (const bad of [null, {}, { totals: null }, { totals: { input_tokens: 1 } }, { totals: { input_tokens: 'x', output_tokens: 1, num_sessions: 1, num_requests: 1, cost_usd: 1 } }, { totals: { input_tokens: -1, output_tokens: 1, num_sessions: 1, num_requests: 1, cost_usd: 1 } }, { totals: { input_tokens: 1, output_tokens: 1, num_sessions: 1, num_requests: 1, cost_usd: NaN } }]) {
    assert.equal(figuresOf(bad), null, JSON.stringify(bad) + ' is not an answer');
}
assert.deepEqual(figuresOf({ totals: { input_tokens: 0, output_tokens: 0, num_sessions: 0, num_requests: 0, cost_usd: 0 } }), { cost: 0, input: 0, output: 0, agents: 0, requests: 0 }, 'a real zero is a zero');

// ── the total is the sum of the rows as they read: costs are rounded the way they are shown before they are added ──
let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(rnd() * 5), costs = Array.from({ length: n }, () => (rnd() < 0.3 ? rnd() * 0.02 : rnd() * 50));
    const rows = costs.map(costUnits), sum = rows.reduce((a, b) => a + b, 0);
    const shown = rows.map(u => Math.round(Number(showUnits(u).slice(1)) * 1e4));
    assert.equal(shown.reduce((a, b) => a + b, 0), sum, `the shown rows ${rows.map(showUnits)} add up to the shown total ${showUnits(sum)}`);
}
assert.equal(showUnits(costUnits(0.004)), '$0.0040', 'a cost under a cent is not shown as zero');

// ── the rows: live, last known, and none ──
const figs = (c, i, o, a, r) => ({ cost: costUnits(c), input: i, output: o, agents: a, requests: r });
const computers = [{ id: 'local', label: 'This computer', online: true, lastSeen: '' }, { id: 'a', label: 'Alpha', online: false, lastSeen: '2026-11-12T10:00:00Z' }, { id: 'b', label: 'Beta', online: false, lastSeen: '' }];
const known = new Map([['local', { figs: figs(2.5, 100, 200, 3, 40), at: Date.parse('2026-11-12T12:00:00Z') }], ['a', { figs: figs(1.25, 50, 60, 1, 9), at: Date.parse('2026-11-12T09:59:00Z') }]]);
const b = breakdown(computers, known, new Set(['local']), Date.parse('2026-11-12T12:00:00Z'));
assert.deepEqual(b.rows.map(r => [r.id, r.state]), [['local', 'live'], ['a', 'last-known'], ['b', 'none']]);
assert.equal(b.rows[1].seen, '2h ago', 'a computer that is not answering says when it was last seen (the Hub\'s own record)');
assert.deepEqual(b.rows[1].figs, figs(1.25, 50, 60, 1, 9), 'its last figures, not zeros');
assert.equal(b.rows[2].figs, null, 'a computer never read has no figures, not zeros');
assert.deepEqual(b.total, { cost: costUnits(2.5) + costUnits(1.25), input: 150, output: 260, agents: 4, requests: 49 }, 'the total is the sum of the rows that have figures');
assert.deepEqual(b.stale, ['Alpha']); assert.deepEqual(b.without, ['Beta']);

// ── the table through the page's own read ──
const reads = []; let answers = {};
const summary = (c, i, o, a, r) => ({ totals: { input_tokens: i, output_tokens: o, num_sessions: a, num_requests: r, cost_usd: c } });
globalThis.fetch = window.fetch = async url => {
    const u = String(url), m = /\/api\/remote\/([^/]+)\//.exec(u), id = m ? m[1] : 'local';
    reads.push({ id, u });
    const a = answers[id];
    if (a === 'down') throw new TypeError('network');
    if (typeof a === 'number') return new Response('{}', { status: a });
    return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
};
const host = document.getElementById('cost-by-computer'), section = document.getElementById('cost-by-computer-section');
assert.ok(host && section, 'the Overview has the By computer section');
const until = async f => { for (let i = 0; i < 300 && !f(); i++) await new Promise(r => setTimeout(r, 10)); };
const rowOf = id => host.querySelector(`tr[data-computer="${id}"]`);
const cells = id => [...rowOf(id).querySelectorAll('td')].map(td => td.textContent.trim());
const totalText = () => (host.querySelector('[data-total]') || {}).textContent || '';

// one computer: nothing to compare, and nothing is asked
forgetReads(); state.hub = false; state.servers = [];
assert.equal(await showByComputer(host, '?since=2026-11-12T00:00:00Z', 'day'), false);
assert.equal(section.hidden, true); assert.equal(section.dataset.empty, '1'); assert.equal(reads.length, 0);

// linked computers: each is read for the same range, totals only
state.hub = true; state.servers = [{ id: 'a', label: 'Alpha', status: 'online', last_seen: '2026-11-12T12:00:00Z' }, { id: 'b', label: 'Beta', status: 'online', last_seen: '2026-11-12T12:00:00Z' }];
answers = { local: summary(2.5, 1000, 2000, 3, 40), a: summary(1.25, 500, 600, 1, 9), b: summary(0.004, 5, 6, 1, 2) };
state.analyticsView = 'overview';
assert.equal(await showByComputer(host, '?since=2026-11-12T00:00:00Z', 'day'), true);
assert.deepEqual(reads.map(r => r.id).sort(), ['a', 'b', 'local']);
for (const r of reads) assert.match(r.u, /\/api\/token-usage\/summary\?since=2026-11-12T00:00:00Z&include=totals$/, 'the same range, totals only: ' + r.u);
assert.equal(section.hidden, false); assert.equal(section.dataset.empty, undefined);
assert.deepEqual(cells('local').slice(0, 6), ['This computer', '$2.50', '1,000', '2,000', '3', '40']);
assert.deepEqual(cells('a').slice(0, 6), ['Alpha', '$1.25', '500', '600', '1', '9']);
assert.deepEqual(cells('b').slice(0, 2), ['Beta', '$0.0040']);
assert.equal(cells('a')[6], 'now');
assert.equal(totalText().replace(/\s+/g, ' ').trim(), 'Total of the computers above$3.7540 · 1,505 in · 2,606 out · 5 agents · 51 requests', totalText());
assert.equal(host.querySelector('.cost-by-computer-note'), null, 'nothing to explain while every computer answers');

// a computer stops answering: its last figures stay, with when it was last seen; the total still adds the rows shown
state.servers[0] = { id: 'a', label: 'Alpha', status: 'offline', last_seen: '2026-11-12T08:00:00Z' };
answers.a = 'down'; answers.b = 502;
await showByComputer(host, '?since=2026-11-12T00:00:00Z', 'day');
assert.deepEqual(cells('a').slice(0, 6), ['Alpha', '$1.25', '500', '600', '1', '9'], 'the last figures, never a zero');
assert.match(cells('a')[6], /^last seen \d+[smhd] ago$|^last seen just now$/, cells('a')[6]);
assert.deepEqual(cells('b').slice(0, 6), ['Beta', '$0.0040', '5', '6', '1', '2'], 'an answer that is an error also leaves the last figures');
assert.match(rowOf('a').title, /last figures read from Alpha/);
assert.equal(totalText().replace(/\s+/g, ' ').trim(), 'Total of the computers above$3.7540 · 1,505 in · 2,606 out · 5 agents · 51 requests', 'the total still adds every row shown');
assert.match(host.querySelector('.cost-by-computer-note').textContent, /Alpha, Beta are not answering: the figures shown are the last ones read, and they are in the total/);

// an answer that is not a summary is a failed read, not zeros
answers.b = { nothing: true };
await showByComputer(host, '?since=2026-11-12T00:00:00Z', 'day');
assert.deepEqual(cells('b').slice(0, 3), ['Beta', '$0.0040', '5'], 'a malformed answer leaves the last figures');

// a computer never read: no figures, said plainly, and not in the total; another range has its own last figures
state.servers.push({ id: 'c', label: 'Gamma', status: 'offline', last_seen: '' });
answers = { local: summary(2.5, 1000, 2000, 3, 40), a: 'down', b: 'down', c: 'down' };
await showByComputer(host, '?since=2026-11-05T00:00:00Z', 'week');
assert.deepEqual(cells('a').slice(0, 3), ['Alpha', '—', '—'], 'a range that was never read from Alpha has no figures, not the day\'s');
assert.deepEqual(cells('c').slice(0, 3), ['Gamma', '—', '—']);
assert.equal(cells('c')[6], 'no figures yet');
assert.equal(totalText().replace(/\s+/g, ' ').trim(), 'Total of the computers above$2.50 · 1,000 in · 2,000 out · 3 agents · 40 requests', 'only the rows with figures are added');
assert.match(host.querySelector('.cost-by-computer-note').textContent, /Alpha, Beta, Gamma have given no figures yet, so they add nothing to the total\. That is not a zero\./);

// a computer's name is text, never markup
state.servers[2] = { id: 'c', label: '<img src=x onerror=alert(1)>', status: 'offline', last_seen: '' };
await showByComputer(host, '?since=2026-11-05T00:00:00Z', 'week');
assert.equal(host.querySelector('img'), null);
assert.ok(host.textContent.includes('<img src=x onerror=alert(1)>'));
console.log('PASS Overview By computer: rows, last known figures, never a zero, total is the sum');
process.exit(0);
