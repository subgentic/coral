/* The Analytics tabs below Overview (#11222, the Operator's approved mockup): Usage (a KPI strip, one stacked bar a day by agent, team, provider or model, and the day's drill-down), Operator interaction (how often
 * the Operator steps in) and Team communication (who @mentions whom, messages a day, asks). Usage reads GET /api/token-usage/timeseries (the same read as Overview, so Hub guests have it); the other two read
 * GET /api/analytics/activity?team=&range= (counts only, never text), which is the Hub owner's: a guest's read is refused and the page says so in one line. A number the read does not carry yet (the
 * Operator's typed messages, answers, wakes and restarts; per-task message counts) is drawn as "not recorded yet", never as zero. Lazy: cost_dashboard.js loads this when one of the three is opened.
 * Everything is built with the DOM and textContent: names are written by agents. */
import { state } from './state.js';
import { isPhoneLayout } from './phone_layout.js';
import { isCloud, serverFetch, spendTeamKeys, splitKey, noteBoardLabels, identityKey } from './server_base.js';
import { teamLabel } from './server_status.js';
import { browserLocal } from './safe_storage.js';
import { loadStyles } from './lazy_styles.js';
import { importOnce } from './import_once.js';
await loadStyles('analytics_tabs.css');
const V = await importOnce('./analytics_viz.js'); // a lazy module loads the others it needs through importOnce, so a failed load is retried
const D = await importOnce('./analytics_tabs_data.js'); // not in the start's stylesheet: it arrives before the page is drawn (#10706)
const { el } = V;
const TEAM_KEY = 'coral-activity-team';
const GUEST_LINE = 'Operator interaction and Team communication are visible to the owner of this Coral only. Usage is available to you.';
const tabs = {
    usage: { range: '14d', metric: 'cost', group: 'agent', day: -1, data: null, status: 'loading', seq: 0, turns: null },
    operator: { range: '14d', team: '', data: null, status: 'loading', seq: 0 },
    comm: { range: '14d', team: '', data: null, status: 'loading', seq: 0 },
};
const hosts = {};
let boards = { keys: [], at: 0 };

/** The teams the person can look at on this computer (and, through a Hub, on its computers): the agents' teams and every team with a board. */
async function readBoards() {
    if (Date.now() - boards.at < 30000) return;
    boards.at = Date.now();
    try {
        const servers = ['local', ...(state.hub ? (state.servers || []).filter(s => s && s.id && s.id !== 'local' && s.status === 'online').map(s => s.id) : [])];
        const lists = await Promise.all(servers.map(async server => {
            try { const r = await serverFetch(server, '/api/board/projects'); const rows = r.ok ? await r.json() : []; if (!Array.isArray(rows)) return []; noteBoardLabels(rows, 'board_id', server); return rows.filter(x => x && x.board_id).map(x => identityKey(server, x.board_id)); } catch { return []; }
        }));
        boards.keys = [...new Set(lists.flat())].sort();
    } catch { /* the agents' teams are still listed */ }
}
const teams = () => spendTeamKeys(state.liveSessions, isCloud(), boards.keys).sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
const todayUTC = () => new Date().toISOString().slice(0, 10);

/** Opens one of the three tabs: draws what it has and reads again. `host` is the tab's section. */
export async function showTab(key, host, force = false) {
    if (!tabs[key]) return;
    hosts[key] = host;
    const m = tabs[key];
    if (key !== 'usage') {
        await readBoards();
        const list = teams(), saved = browserLocal.get(TEAM_KEY) || '';
        m.team = list.includes(m.team) ? m.team : (list.includes(saved) ? saved : (list[0] || ''));
    }
    draw(key);
    if (force || !m.data || m.stale) load(key);
}

async function load(key) {
    const m = tabs[key], seq = ++m.seq;
    m.status = m.data ? 'ok' : 'loading'; m.stale = false;
    try {
        if (key === 'usage') {
            const days = D.daysOf(m.range), since = new Date(Date.parse(todayUTC() + 'T00:00:00Z') - (2 * days - 1) * 86400000).toISOString();
            const r = await serverFetch('local', `/api/token-usage/timeseries?since=${encodeURIComponent(since)}&interval=1d&group_by=${encodeURIComponent(m.group)}`);
            if (seq !== m.seq) return;
            if (!r.ok) throw new Error(String(r.status));
            m.data = (await r.json()).buckets || []; m.status = 'ok'; m.day = -1; m.turns = null;
        } else {
            if (!m.team) { m.status = 'noteam'; m.data = null; draw(key); return; }
            const { server, name } = splitKey(m.team);
            const r = await serverFetch(server, `/api/analytics/activity?team=${encodeURIComponent(name)}&range=${encodeURIComponent(m.range)}`);
            if (seq !== m.seq) return;
            if (r.status === 401 || r.status === 403 || (r.status === 404 && isCloud())) { m.status = 'guest'; m.data = null; draw(key); return; }
            if (!r.ok) throw new Error(String(r.status));
            m.data = (await r.json()).activity || {}; m.status = 'ok';
        }
    } catch { if (seq !== m.seq) return; m.status = 'error'; }
    draw(key);
}

const phone = () => isPhoneLayout();
const reload = (key) => { const m = tabs[key]; m.data = null; m.status = 'loading'; draw(key); load(key); };

function filterBar(key) {
    const m = tabs[key], bar = el('div', 'atab-filters');
    bar.append(V.selectField('Period', D.RANGES, m.range, v => { m.range = v; reload(key); }));
    if (key === 'usage') {
        bar.append(V.selectField('Group by', [['agent', 'Agent'], ['team', 'Team'], ['provider', 'Agent type'], ['model', 'Model']], m.group, v => { m.group = v; reload(key); }));
        bar.append(V.segment('Chart shows', D.METRICS, m.metric, v => { m.metric = v; m.day = -1; m.turns = null; draw(key); }));
    } else {
        const list = teams();
        bar.append(V.selectField('Team', list.length ? list.map(k => [k, teamLabel(k)]) : [['', 'No team yet']], m.team, v => { m.team = v; browserLocal.set(TEAM_KEY, v); reload(key); }));
    }
    return bar;
}

function say(text, cls = 'atab-say') { const p = el('p', cls, text); p.setAttribute('role', 'status'); return p; }

function draw(key) {
    const host = hosts[key]; if (!host || !host.isConnected) return;
    const m = tabs[key], root = el('div', 'atab' + (phone() ? ' atab-phone' : ''));
    root.append(filterBar(key));
    if (m.status === 'guest') root.append(say(GUEST_LINE));
    else if (m.status === 'noteam') root.append(say('No team has a board yet. Start a team and its numbers appear here.'));
    else if (m.status === 'error') { const p = say('This could not be read.'); const b = el('button', 'btn btn-sm', 'Try again'); b.type = 'button'; b.addEventListener('click', () => reload(key)); p.append(' ', b); root.append(p); }
    else if (!m.data) root.append(say('Loading…'));
    else root.append(...({ usage: drawUsage, operator: drawOperator, comm: drawComm }[key])(m));
    const focus = host.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    host.replaceChildren(root);
    if (focus) host.querySelector(`[aria-label="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
}

/* ---- Usage ---- */
function drawUsage(m) {
    const days = D.daysOf(m.range), u = D.usageModel(m.data, { days, metric: m.metric, today: todayUTC() });
    if (u.empty) return [say('Nothing was spent in this period. Spend counts the agents Coral has run.')];
    if (m.day < 0 || m.day >= u.rows.length) m.day = u.busiest ? u.rows.indexOf(u.busiest) : u.rows.length - 1;
    const c = u.cur, p = u.prev, more = (a, b) => { const t = V.changeWords(a, b); return !t ? '' : t === 'same as before' ? `same as the ${days} days before` : `${t} than the ${days} days before`; };
    const kpis = V.kpiStrip([
        { label: 'Spend', value: D.fmtMoney(c.cost), delta: more(c.cost, p.cost), good: c.cost <= p.cost ? true : false, note: 'cost of every turn' },
        { label: 'Tokens', value: D.fmtCount(c.tokens), delta: more(c.tokens, p.tokens), good: null, note: 'input plus output; cache reads beside' },
        { label: 'Cache reads', value: D.fmtCount(c.cacheRead), delta: more(c.cacheRead, p.cacheRead), good: null, note: 'not in the tokens above' },
        { label: 'Requests', value: D.fmtCount(c.requests), delta: more(c.requests, p.requests), good: null, note: 'model calls' },
        { label: 'Cost per request', value: c.requests ? D.fmtMoney(c.cost / c.requests) : '—', delta: p.requests && c.requests ? more(c.cost / c.requests, p.cost / p.requests) : '', good: null, note: 'spend ÷ requests' },
        { label: 'Busiest day', value: u.busiest ? u.busiest.label : '—', delta: u.busiest ? D.fmtMetric(m.metric, u.busiest.total) : '', good: null, note: 'by the chart’s measure' },
    ]);
    const fmt = (v) => D.fmtMetric(m.metric, v), texts = u.rows.map(r => `${r.label} · ${fmt(r.total)}`);
    const chart = V.stackedBars(u.rows, u.series, { fmt, selected: m.day, phone: phone(), label: 'Usage over time', onPick: i => { m.day = i; m.turns = null; draw('usage'); } });
    const hero = V.panel('Usage over time', `${D.METRICS.find(x => x[0] === m.metric)[1]} a day, by ${({ agent: 'agent', team: 'team', provider: 'agent type', model: 'model' })[m.group]}`,
        V.dayPicker(u.rows, m.day, texts, i => { m.day = i; m.turns = null; draw('usage'); }), chart, V.legend(u.series));
    const row = u.rows[m.day], rank = D.dayRanking(row, u.series, m.metric);
    const list = V.rankedBars(rank.map(r => ({ name: r.name, value: r.value, i: r.i, text: `${fmt(r.value)} · ${Math.round(r.share * 100)}%` })));
    const drill = V.panel(row.label, `${fmt(row.total)} that day`, list);
    if (m.group === 'agent' && rank.length) {
        const top = rank.find(r => r.key !== '__other') || rank[0];
        const b = el('button', 'btn btn-sm atab-drill', `Biggest turns of ${top.name}`); b.type = 'button';
        b.addEventListener('click', () => loadTurns(top.name, row.day));
        drill.append(b);
        if (m.turns && m.turns.agent === top.name && m.turns.day === row.day) drill.append(turnsTable(m.turns));
    }
    return [kpis, ...(phone() ? [hero, drill] : [rowOf(hero, drill)])];
}
const rowOf = (a, b) => { const r = el('div', 'atab-row2'); r.append(a, b); return r; };

async function loadTurns(agent, day) {
    const m = tabs.usage;
    m.turns = { agent, day, rows: null }; draw('usage');
    try {
        const r = await serverFetch('local', `/api/token-usage/turns?agent=${encodeURIComponent(agent)}&since=${encodeURIComponent(day + 'T00:00:00.000Z')}&until=${encodeURIComponent(new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString())}&order=cost&limit=8`);
        if (!r.ok) throw new Error(String(r.status));
        const rows = (await r.json()).turns || [];
        if (m.turns && m.turns.agent === agent && m.turns.day === day) m.turns.rows = rows;
    } catch { if (m.turns) m.turns.rows = []; m.turns && (m.turns.error = true); }
    draw('usage');
}
function turnsTable(t) {
    if (!t.rows) return say('Loading the turns…');
    if (!t.rows.length) return say(t.error ? 'The turns could not be read.' : 'No turns recorded for this agent on this day.');
    return V.plainTable(['Time (UTC)', 'Model', 'Cost', 'Tokens'], t.rows.map(r => [String(r.timestamp || '').slice(11, 16), r.model || '—', D.fmtMoney(r.cost_usd || 0), D.fmtCount((r.input_tokens || 0) + (r.output_tokens || 0))]), { right: [2, 3], label: `Biggest turns of ${t.agent}` });
}

/* ---- Operator interaction ---- */
function pendingNote(text) { const n = el('p', 'atab-pending'); n.append(el('b', null, 'Not recorded yet. '), document.createTextNode(text)); return n; }
const trendBody = (chart, line) => { const d = el('div', 'atab-trend'); d.append(chart, line); return d; };
const kv = (label, value, note, extra) => ({ label, value, note, pending: value === D.NOT_RECORDED, ...extra });
function drawOperator(m) {
    const o = D.operatorModel(m.data);
    const a = o.asks;
    const kpis = V.kpiStrip([
        kv('Operator board posts', D.countWords(o.posts), 'posts signed as the Operator'),
        kv('Posts per task done', D.perTaskWords(o.posts, o.tasksDone), o.tasksDone == null ? '' : `${o.tasksDone} tasks done in the period`),
        kv('Asks to the Operator', D.countWords(a && a.asked), a ? `${a.answered} answered` : ''),
        kv('Median wait for an answer', D.waitWords(a, 'median_s'), 'from the ask to the first reply'),
        kv('Slowest wait', D.waitWords(a, 'slowest_s'), 'of the answered asks'),
        kv('Touches (all kinds)', o.recorded ? String(o.touches) : D.NOT_RECORDED, !o.recorded ? '' : o.hub ? `${o.hub} of them through Coral Hub` : 'every kind below'),
    ]);
    const out = [kpis];
    if (!o.recorded) out.push(pendingNote('Typed messages, answers to prompts, approvals, wakes, restarts and stops are counted from a recording that is being added. Until then this tab shows the Operator’s board posts and asks.'));
    const chart = V.stackedBars(o.days, o.kinds, { fmt: D.fmtCount, phone: phone(), label: 'Operator touches over time' });
    const hero = V.panel('Operator touches over time', 'a day', chart, V.legend(o.kinds));
    const who = V.panel('Who needs the Operator', 'asks and @mentions of the Operator',
        o.agents.length ? V.rankedBars(o.agents.slice(0, 8).map((g, i) => ({ name: g.name, value: g.need, i, text: `${g.asks} ${g.asks === 1 ? 'ask' : 'asks'} · ${g.toOperator} @${g.toOperator === 1 ? 'mention' : 'mentions'}` }))) : say('No agent asked or @mentioned the Operator in this period.'));
    const tr = D.autonomyTrend(o.days);
    const trend = V.panel('Autonomy', 'touches per task done, over 7 days', !o.recorded ? pendingNote('The trend needs every kind of touch. It appears when they are recorded.')
        : !tr.enough ? say('The trend needs at least 8 days with a task done in them. Choose a longer period.')
        : trendBody(V.lineChart(tr.points, { fmt: (v) => v.toFixed(1), phone: phone() }), say(`${tr.last.value.toFixed(1)} touches per task done in the 7 days to ${tr.last.label}, against ${tr.first.value.toFixed(1)} in the 7 days to ${tr.first.label}. Fewer is more autonomy.`)));

    if (phone()) out.push(hero, trend, who); else out.push(rowOf(hero, trend), who);
    out.push(V.panel('Wait for the Operator', 'asks only', V.plainTable(['', 'Asks'], [['Asked', D.countWords(a && a.asked)], ['Answered', D.countWords(a && a.answered)], ['Not yet answered', D.countWords(a && Math.max(0, a.asked - a.answered))], ['Median wait', D.waitWords(a, 'median_s')], ['Slowest wait', D.waitWords(a, 'slowest_s')]], { right: [1], label: 'Wait for the Operator' }), o.recorded ? el('span') : pendingNote('Waits for a permission prompt are added with the recording.')));
    if (o.truncated) out.push(say(`This period holds more than ${D.fmtCount(50000)} messages; the first ones are counted.`));
    return out;
}

/* ---- Team communication ---- */
function drawComm(m) {
    const c = D.commModel(m.data), k = c.kpis;
    if (c.empty) return [say('No agent wrote to the board in this period.')];
    const asks = k.asks;
    const kpis = V.kpiStrip([
        kv('Messages by agents', D.countWords(k.agent == null ? null : D.fmtCount(k.agent)), k.automated == null ? '' : `${D.fmtCount(k.automated)} automated notices counted apart`),
        kv('Per task done', D.perTaskWords(k.agent, k.tasksDone), k.tasksDone == null ? '' : `${k.tasksDone} tasks done`),
        kv('With other teams', D.countWords(k.cross == null ? null : D.fmtCount(k.cross)), 'sent and received'),
        kv('Tasks handed to another agent', D.countWords(k.assigned), 'created for someone else'),
        kv('Median reply to an ask', D.waitWords(asks, 'median_s'), asks ? `${asks.answered} of ${asks.asked} answered` : ''),
        kv('Busiest pair', k.busiest ? `${k.busiest.from} \u2192 ${k.busiest.to}` : 'No @mentions', k.busiest ? `${k.busiest.count} @mentions` : ''),
    ]);
    const kinds = [{ key: 'posts', name: 'Messages by agents' }, { key: 'cross', name: 'With other teams' }, { key: 'automated', name: 'Automated notices' }];
    const who = V.panel('Who talks to whom', 'an @mention is a message to that agent', c.names.length ? V.matrix(c.names, c.cells, { phone: phone() }) : say('No agent @mentioned another in this period.'));
    const over = V.panel('Messages over time', 'a day', V.stackedBars(c.days, kinds, { fmt: D.fmtCount, phone: phone(), label: 'Messages over time' }), V.legend(kinds));
    const out = [kpis, who, over]; // stacked at every width: beside the grid the chart was 320 px and its axis text 4.6 px
    out.push(V.panel('Sent and received by agent', 'received counts @mentions', V.plainTable(['Agent', 'Sent', 'Received'], c.agents.map(g => [g.name, String(g.sent), String(g.received)]), { right: [1, 2], label: 'Messages sent and received by agent' })));
    out.push(V.panel('Messages per agent and task', 'sent and received while on the task', c.tasks
        ? V.plainTable(['Task', 'Agent', 'Sent', 'Received', 'Within team', 'Across teams'], c.tasks.map(t => [`#${t.task_id}`, t.agent, String(t.sent), String(t.received), String(t.within), String(t.across)]), { right: [2, 3, 4, 5], label: 'Messages per agent and task' })
        : pendingNote('Per-task message counts are added with the recording.')));
    if (c.truncated) out.push(say(`This period holds more than ${D.fmtCount(50000)} messages; the first ones are counted.`));
    return out;
}

// A new team, a changed range or a refresh of the page reads again.
document.addEventListener('cost-view-change', () => { for (const k of Object.keys(tabs)) tabs[k].stale = true; });
window.addEventListener('resize', () => { for (const k of Object.keys(tabs)) if (hosts[k] && hosts[k].isConnected && hosts[k].offsetParent) draw(k); });
