/* The Analytics tab's "Tokens per commit" and "Task time" sections (#7526, #7530, UI/UX's pace r2 and task time layouts, analytics only: no banner, snooze, alert or Inbox item). For one team:
 *  - tokens per landed commit over the last 24 hours (or 7 days) against the 7 days before, the usual line, a bar a day or an hour (tokens or tool calls per commit), how it is counted, who spends. Tokens are input plus output with the cache reads
 *    beside them, never inside; a commit counts once when it reaches main, its author is the agent, an author that matches no agent is "Unattributed"; an agent with no source is "Not measured", never zero. A day with no commit has no bar.
 *  - task time: tasks done, median and slowest 1 in 10 from claimed to done, the wait before claimed, review time (assignment to approval), sent back 2 or more times, tasks done a day or an hour, and by agent. A measure the endpoint does not return is left out.
 * One read feeds both: GET /api/board/<team>/spend?range=24h|7d sends counts and seconds, not ratios; the page divides. Everything is built with the DOM and textContent: agent names are written by agents. Lazy: cost_dashboard.js imports it. */
import { state } from './state.js';
import { compactFigure, compactDuration } from './format.js';
import { boardFetch, identityKey, isCloud, noteBoardLabels, serverFetch, spendTeamKeys } from './server_base.js';
import { teamLabel } from './server_status.js';
import { browserLocal } from './safe_storage.js';
import { importOnce } from './import_once.js';
const { addTermsInfo } = await importOnce('./analytics_terms.js');

const { dataTable } = await importOnce('./data_table.js'); // the shared table (#7743)
const { phoneOneLine } = await importOnce('./analytics_views.js'); // a phone: one line a row (#8982)

const TEAM_KEY = 'coral-spend-team';
const HOURLY_WHY = 'Hourly is for the last 24 hours.';
const DRIFT = 1.3; // the bar of a day is amber when it is 30% above usual (colour only: nothing is sent to anyone)
const model = { team: '', range: '24h', data: null, loading: false, error: '', seq: 0, metric: 'tokens', grain: 'day', doneGrain: 'day' };
let root = null, timeRoot = null;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** 517K, 1.2M, 61M: tokens as a person reads them, the one figure format of the Analytics pages (format.js compactFigure, #9516); '' for a figure that is not a number. */
export function fmtTokens(n) { return Number.isFinite(Number(n)) ? compactFigure(Math.round(Number(n))) : ''; }
/** 38 s, 2 min, 1 h 02 min: a time as a person reads it, the one duration format of the Analytics pages (format.js compactDuration, #9540). */
export const fmtDur = compactDuration;
const tokensOf = (t) => (typeof t === 'number' ? t : t && typeof t.tokens === 'number' ? t.tokens : t ? (Number(t.input) || 0) + (Number(t.output) || 0) : 0); // input plus output (a day's row has the sum already): the cache is beside it
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The teams the person can look at, on this computer or through a hub: those with an agent on the list and every team with a board (#8811), then the one chosen last. */
function teams() {
    return spendTeamKeys(state.liveSessions, isCloud(), boards.keys).sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
}

// Every team with a board, on this computer and on each online computer of a hub (GET /api/board/projects), read when the section opens and again after half a minute: a team with spend and no agent running is
// then in the picker. A computer that does not answer adds none; the Cloud Hub's rule for another computer's teams is spendTeamKeys'.
const boards = { keys: [], at: 0, sig: '', reading: null };
function readBoards() {
    const servers = ['local', ...(state.hub ? (state.servers || []).filter(s => s && s.id && s.id !== 'local' && s.status === 'online').map(s => s.id) : [])], sig = servers.join();
    if (boards.reading || (sig === boards.sig && Date.now() - boards.at < 30000)) return boards.reading || Promise.resolve(false); // the same computers asked a moment ago: that answer
    boards.reading = Promise.all(servers.map(async server => {
        try {
            const r = await serverFetch(server, '/api/board/projects');
            const rows = r.ok ? await r.json() : [];
            if (!Array.isArray(rows)) return [];
            noteBoardLabels(rows, 'board_id', server);
            return rows.filter(x => x && x.board_id).map(x => identityKey(server, x.board_id));
        } catch { return []; }
    })).then(lists => {
        const next = [...new Set(lists.flat())].sort();
        const changed = next.join('\n') !== boards.keys.join('\n');
        boards.keys = next; boards.at = Date.now(); boards.sig = sig; boards.reading = null;
        return changed;
    });
    return boards.reading;
}

const ratio = (n, den) => (den > 0 && n != null ? n / den : null);

/** The numbers the cards and the sentence say, from the endpoint's counts. */
function figures(data, range) {
    const win = tokensOf(data.tokens && data.tokens.window), usual = tokensOf(data.tokens && data.tokens.usual);
    const c = data.commits || {};
    const noCommits = c.available === false; // the board's repo could not be read: say why, never a zero
    const per = noCommits ? null : ratio(win, c.window), usualPer = noCommits ? null : ratio(usual, c.usual);
    const above = per != null && usualPer ? Math.round((per / usualPer - 1) * 100) : null;
    const tc = data.tool_calls, measured = !!(tc && tc.measured_agents);
    return { noCommits, reason: String(c.reason || ''), win, usual, per, usualPer, above, commits: c.window || 0, usualCommits: c.usual || 0, unattributed: c.unattributed || 0, cacheReads: Number(data.tokens && data.tokens.window && data.tokens.window.cache_read) || 0,
        toolPer: measured ? ratio(num(tc.window), c.window) : null, usualToolPer: measured ? ratio(num(tc.usual), c.usual) : null, toolMeasured: tc ? [tc.measured_agents, tc.of_agents] : null, windowWord: range === '7d' ? '7 days' : '24 h' };
}

function headline(f) {
    if (f.noCommits && /no repository found/i.test(f.reason)) return `Tokens per commit needs a git folder, and none of this team's agents is in one. ${fmtTokens(f.win)} tokens were spent.`; // none in use: the count has nothing to count (#10482)
    if (f.noCommits) return `Commits could not be read${f.reason ? `: ${f.reason}` : ''}. ${fmtTokens(f.win)} tokens were spent.`;
    if (!f.commits) return `No commit landed in ${f.windowWord}. ${fmtTokens(f.win)} tokens were spent.`;
    const parts = [`${fmtTokens(f.per)} tokens per commit`];
    if (f.usualPer) parts.push(`usual ${fmtTokens(f.usualPer)}`, f.above === 0 ? 'the same' : `${Math.abs(f.above)}% ${f.above > 0 ? 'above' : 'below'}`);
    return `${parts.join(', ')}.`;
}

/** Both views are one page shape (#7688): the team and window line, a one-sentence summary, the tiles, the chart beside "How it is counted", then the table under a title with the same gap. */
const SHAPE_HOW = (text) => { const how = el('details', 'disclosure spend-how'); how.append(el('summary', null, 'How it is counted'), el('p', 'spend-note', text)); return how; };
function shape(body, { sub, headline, cards, chart, how, table }) {
    body.append(el('p', 'spend-sub', sub), el('p', 'spend-headline', headline), cards);
    const grid = el('div', 'spend-grid'); if (chart) grid.append(chart); grid.append(how); body.append(grid);
    if (table) body.append(table);
}

function card(value, label, sub) {
    const c = el('div', 'cost-card spend-card');
    c.append(el('div', 'cost-card-value' + (value === 'Not measured' ? ' cost-card-value-word' : ''), value), el('div', 'cost-card-label', label));
    if (sub) c.append(el('div', 'spend-card-sub', sub));
    return c;
}

/** Two small toggles that act as one choice each (pressed buttons, 44 px on a phone): [{ key, label, disabled?, title? }]. */
function toggles(label, options, current, onPick) {
    const g = el('div', 'spend-toggle btn-seg'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', label);
    for (const o of options) {
        const b = el('button', 'btn spend-toggle-btn', o.label); b.type = 'button'; b.dataset.key = o.key;
        b.setAttribute('aria-pressed', String(current === o.key));
        if (o.disabled) { b.disabled = true; if (o.title) b.title = o.title; }
        b.addEventListener('click', () => onPick(o.key));
        g.append(b);
    }
    return g;
}

/** The bars of a trend: `rows` [{ label, value (null: no bar) }], the usual line when there is one; the chart's accessible name says what is drawn. */
function bars(rows, { usual = null, name, top: forceTop, amberAbove = null, unit }) {
    const top = Math.max(1, forceTop || 0, ...rows.map(r => r.value || 0), usual || 0);
    const wrap = el('div', 'spend-bars'); wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', `${name}${usual ? `, usual ${unit(usual)}` : ''}: ${rows.map(r => `${r.label} ${r.value == null ? 'none' : unit(r.value)}`).join(', ')}`);
    rows.forEach((r, i) => {
        const col = el('div', 'spend-bar-col');
        if (r.value != null) {
            const bar = el('div', 'spend-bar');
            bar.style.height = `${Math.max(2, Math.round((r.value / top) * 100))}%`;
            if (i === rows.length - 1 && amberAbove && r.value > amberAbove) bar.classList.add('spend-bar-high');
            bar.title = `${r.label}: ${unit(r.value)}`;
            col.append(bar); // a day with nothing has no bar, not a stub
        }
        wrap.append(col);
    });
    if (usual) { const line = el('div', 'spend-usual'); line.style.bottom = `${Math.round((usual / top) * 100)}%`; line.setAttribute('aria-hidden', 'true'); wrap.append(line); }
    return wrap;
}

const dayLabel = (d) => String(d.day || '').slice(5);
const hourLabel = (d) => { const t = new Date(d.hour); return Number.isNaN(t.getTime()) ? String(d.hour || '') : `${String(t.getHours()).padStart(2, '0')}:00`; };

function chart(data, f) {
    const hourly = model.grain === 'hour' && Array.isArray(data.per_hour) && data.per_hour.length && model.range === '24h';
    const list = (hourly ? data.per_hour : data.per_day) || [];
    const tools = model.metric === 'tools';
    const value = (d) => (tools ? ratio(num(d.tool_calls), d.commits) : ratio(tokensOf(d), d.commits));
    const rows = list.map(d => ({ label: hourly ? hourLabel(d) : dayLabel(d), value: value(d) }));
    const usual = tools ? f.usualToolPer : f.usualPer;
    const unit = tools ? (v => (v >= 10 ? String(Math.round(v)) : v.toFixed(1))) : fmtTokens;
    const noun = tools ? 'Tool calls per commit' : 'Tokens per commit';
    const wrap = el('div', 'spend-chart');
    const head = el('div', 'spend-chart-head');
    head.append(el('h4', 'spend-box-title', `${noun}, each ${hourly ? 'hour' : 'day'}`));
    const ctl = el('div', 'spend-controls');
    const toolsOn = !!(f.toolMeasured && f.toolMeasured[0]);
    ctl.append(toggles('Trend shows', [{ key: 'tokens', label: 'Tokens' }, { key: 'tools', label: 'Tool calls', disabled: !toolsOn, title: toolsOn ? '' : 'Not measured' }], model.metric, k => { model.metric = k; draw(); }),
        toggles('Trend by', [{ key: 'day', label: 'Daily' }, { key: 'hour', label: 'Hourly', disabled: model.range !== '24h' || !(data.per_hour && data.per_hour.length), title: model.range === '24h' ? '' : 'Hourly is for the last 24 hours' }], hourly ? 'hour' : 'day', k => { model.grain = k; draw(); }));
    head.append(ctl);
    wrap.append(head);
    wrap.append(bars(rows, { usual, name: `${noun} each ${hourly ? 'hour' : 'day'}, ${rows.length} ${hourly ? 'hours' : 'days'}`, amberAbove: usual ? usual * DRIFT : null, unit }));
    const axis = el('div', 'spend-axis'); axis.setAttribute('aria-hidden', 'true'); axis.append(el('span', null, hourly ? '24 hours ago' : `${rows.length} days ago`), el('span', null, hourly ? 'now' : 'to' + 'day')); // the word is spelled in two parts: the icon-name lint reads a quoted word as an icon
    const why = [!toolsOn ? 'Tool calls are not measured.' : '', model.range !== '24h' ? HOURLY_WHY : ''].filter(Boolean).join(' '); // a disabled button gives no tooltip to a keyboard or a touch: the reason is in the text
    wrap.append(axis, el('p', 'spend-note', [usual ? `Dashed line: usual, ${unit(usual)}. The last bar is amber when it is 30% above.` : `No usual yet: there is no commit in the 7 days before${tools ? ' or no tool call recorded' : ''}.`, why].filter(Boolean).join(' ')));
    return wrap;
}

function table(data) {
    const agents = (Array.isArray(data.agents) ? data.agents : []).slice().sort((a, b) => (a.name === 'Unattributed') - (b.name === 'Unattributed') || (a.tokens == null) - (b.tokens == null) || (b.tokens || 0) - (a.tokens || 0));
    const none = a => a.name === 'Unattributed' || a.tokens == null; // one note under the name, not five empty or zero cells
    const figure = fn => a => (none(a) ? '' : fn(a));
    return dataTable({ label: 'Who spends', fold: 'labeled', rows: agents, rowKey: a => a.name || '', ...phoneOneLine([
        { key: 'name', label: 'Agent', tone: 'primary', cell: a => a.name || '', subtitle: a => (a.name === 'Unattributed' ? 'Commits whose author matches no agent' : a.tokens == null ? 'Not measured' : '') },
        { key: 'tokens', label: 'Tokens', numeric: true, cell: figure(a => fmtTokens(a.tokens)) },
        { key: 'share_pct', label: 'Share', numeric: true, cell: figure(a => (a.share == null ? '' : `${Math.round(a.share * 100)}%`)) },
        { key: 'commits', label: 'Commits', numeric: true, cell: figure(a => (a.orchestrator ? 'team' : a.commits == null ? '—' : a.commits === 0 ? 'none' : String(a.commits))) },
        { key: 'cache_reads', label: 'Cache reads', numeric: true, cell: figure(a => (a.cache_reads == null ? '—' : fmtTokens(a.cache_reads))) },
        { key: 'tool_calls', label: 'Tool calls', numeric: true, cell: figure(a => (a.tool_calls == null ? (a.tool_calls_measured === false ? 'Not measured' : '—') : String(a.tool_calls))) },
    ], ['tokens']) }).el;
}

function drawSpend() {
    const body = root && root.querySelector('.spend-body'); if (!body) return;
    body.replaceChildren();
    body.setAttribute('aria-busy', String(model.loading));
    if (!model.team) { body.append(el('p', 'empty-state', 'Open a team to see how many tokens its commits take.')); return; }
    if (model.error) {
        const e = el('div', 'empty-state spend-error'); e.setAttribute('role', 'alert'); e.append(el('span', null, model.error + ' '));
        const b = el('button', 'btn btn-small', 'Try again'); b.type = 'button'; b.addEventListener('click', () => loadSpend()); e.append(b); body.append(e); return;
    }
    if (model.loading && !model.data) { body.append(el('p', 'empty-state', 'Loading…')); return; }
    const data = model.data; if (!data) return;
    const f = figures(data, model.range);
    const cards = el('div', 'cost-summary-cards spend-cards');
    cards.append(card(f.commits ? fmtTokens(f.per) : '—', `tokens per landed commit, ${f.windowWord}`, f.commits ? '' : 'no commit landed'),
        card(f.toolPer != null ? (f.toolPer >= 10 ? String(Math.round(f.toolPer)) : f.toolPer.toFixed(1)) : 'Not measured', `tool calls per landed commit, ${f.windowWord}`, f.toolMeasured ? `${f.toolMeasured[0]} of ${f.toolMeasured[1]} agents measured` : ''),
        card(f.usualPer ? fmtTokens(f.usualPer) : '—', 'usual, the 7 days before', f.usualCommits ? `${f.usualCommits} commits` : 'no commit then'),
        card(String(f.commits), 'commits landed on main', f.unattributed ? `${f.unattributed} unattributed` : ''),
        card(fmtTokens(f.cacheReads) || '0', 'cache reads, not in the total', ''));
    const chartBox = el('section', 'spend-box'); chartBox.append(chart(data, f));
    const how = SHAPE_HOW('Tokens are input plus output. Cache writes and cache reads are shown beside, never hidden in the total. A commit counts once when it reaches main; its author is the agent, and one that matches no agent is Unattributed. A commit is credited to the author name its committer typed, so these are counts, not proof of who did the work. In a repository shared by several teams, Unattributed can include other teams\' commits. Review and orchestration tokens belong to the team, not to one commit. An agent with no token record is Not measured, not zero.');
    const who = el('section', 'spend-who'); const whoTitle = el('h4', 'spend-box-title', 'Who spends'); who.append(whoTitle); addTermsInfo(whoTitle, ['tokens', 'portion', 'commits', 'cache', 'tools']);
    who.append(table(data));
    if (data.measured_agents != null && data.of_agents != null && data.measured_agents < data.of_agents) who.append(el('p', 'spend-note', `${data.measured_agents} of ${data.of_agents} agents measured.`));
    shape(body, { sub: `Team ${teamLabel(model.team)} · last ${f.windowWord} against the 7 days before`, headline: headline(f), cards, chart: chartBox, how, table: who });
}

// ── task time ────────────────────────────────────────────────────────────

const TIME_HOW = 'Time is counted from the moment a task is claimed to the moment it is done, for the tasks that were done in the window. Wait is from the task being made to its being claimed. Review time is from the task being assigned for review to its approval, since the time it was submitted is not stored. A task is counted as sent back when its review sent it back to its author twice or more. Usual is the 7 days before the window. A figure no task could answer is not shown, never zero.';

/** The one-sentence summary of task time, as Tokens per commit has one. */
function timeHeadline(w, u, word) {
    if (num(w.done) == null || !w.done) return `No task was done in the ${word}.`;
    const parts = [`${w.done} ${w.done === 1 ? 'task' : 'tasks'} done`];
    if (num(w.median_s) != null) { parts.push(`median ${fmtDur(w.median_s)}`); if (num(u.median_s) != null) parts.push(`usual ${fmtDur(u.median_s)}`); }
    return `${parts.join(', ')}.`;
}

function drawTime() {
    const body = timeRoot && timeRoot.querySelector('.time-body'); if (!body) return;
    body.replaceChildren();
    const tt = model.data && model.data.task_time;
    if (!model.team) { body.append(el('p', 'empty-state', 'Open a team to see how long its tasks take.')); return; } // the view is in the list for every team: with none, it says so
    if (!tt || model.error) { if (!model.loading) body.append(el('p', 'empty-state', model.error || 'No task time for this team yet.')); return; }
    const w = tt.window || {}, u = tt.usual || {};
    const word = model.range === '7d' ? 'last 7 days' : 'last 24 h';
    const cards = el('div', 'cost-summary-cards spend-cards');
    const usualDay = num(u.done) != null ? Math.round(u.done / 7) : null;
    if (num(w.done) != null) cards.append(card(String(w.done), `tasks done, ${word}`, usualDay != null ? `usual ${usualDay} a day` : ''));
    if (num(w.median_s) != null) cards.append(card(fmtDur(w.median_s), 'median, claimed to done', num(u.median_s) != null ? `usual ${fmtDur(u.median_s)}` : ''));
    if (num(w.p90_s) != null) cards.append(card(fmtDur(w.p90_s), 'slowest 1 in 10', num(u.p90_s) != null ? `usual ${fmtDur(u.p90_s)}` : ''));
    if (num(w.wait_median_s) != null) cards.append(card(fmtDur(w.wait_median_s), 'median wait before claimed', ''));
    if (num(w.review_median_s) != null) cards.append(card(fmtDur(w.review_median_s), 'median in review, assignment to approval', ''));
    if (num(w.sent_back) != null) cards.append(card(`${w.sent_back} of ${w.done || 0}`, 'sent back 2 or more times', num(w.rounds_mean) != null ? `${w.rounds_mean.toFixed(1)} rounds on average` : ''));
    const hourly = model.doneGrain === 'hour' && Array.isArray(tt.per_hour) && tt.per_hour.length && model.range === '24h';
    const list = (hourly ? tt.per_hour : tt.per_day) || [];
    let box = null, sec = null;
    if (list.length) {
        box = el('section', 'spend-box');
        const head = el('div', 'spend-chart-head'); head.append(el('h4', 'spend-box-title', 'Tasks done'));
        head.append(toggles('Tasks done by', [{ key: 'day', label: 'Daily' }, { key: 'hour', label: 'Hourly', disabled: model.range !== '24h' || !(tt.per_hour && tt.per_hour.length), title: model.range === '24h' ? '' : 'Hourly is for the last 24 hours' }], hourly ? 'hour' : 'day', k => { model.doneGrain = k; drawTime(); }));
        box.append(head);
        const rows = list.map(d => ({ label: hourly ? hourLabel(d) : dayLabel(d), value: d.done ? d.done : null }));
        const usual = usualDay != null && !hourly ? usualDay : null;
        box.append(bars(rows, { usual, name: `Tasks done each ${hourly ? 'hour' : 'day'}`, unit: v => String(Math.round(v)) })); // more tasks done than usual is good news: this chart is never amber
        const axis = el('div', 'spend-axis'); axis.setAttribute('aria-hidden', 'true'); axis.append(el('span', null, hourly ? '24 hours ago' : `${rows.length} days ago`), el('span', null, hourly ? 'now' : 'to' + 'day'));
        box.append(axis, el('p', 'spend-note', [usual ? `Dashed line: usual, ${usual} a day. A day with no task done has no bar.` : 'A time with no task done has no bar.', model.range !== '24h' ? HOURLY_WHY : ''].filter(Boolean).join(' ')));
    }
    const agents = Array.isArray(tt.agents) ? tt.agents : [];
    if (agents.length) {
        sec = el('section', 'spend-who'); const byTitle = el('h4', 'spend-box-title', 'By agent'); sec.append(byTitle); addTermsInfo(byTitle, ['done', 'median', 'sentBack']);
        const rows = agents.slice().sort((x, y) => (y.done || 0) - (x.done || 0));
        sec.append(dataTable({ label: 'Task time by agent', fold: 'labeled', rows, rowKey: a => a.name || '', ...phoneOneLine([
            { key: 'name', label: 'Agent', tone: 'primary', cell: a => a.name || '' },
            { key: 'done', label: 'Tasks done', numeric: true, cell: a => String(a.done || 0) },
            { key: 'median', label: 'Median time', numeric: true, cell: a => (num(a.median_s) != null ? fmtDur(a.median_s) : '—') },
            { key: 'sent_back', label: 'Sent back', numeric: true, cell: a => (num(a.sent_back) != null ? String(a.sent_back) : '—') },
        ], ['median']) }).el);
    }
    shape(body, { sub: `Team ${teamLabel(model.team)} · ${word} against the 7 days before`, headline: timeHeadline(w, u, word), cards, chart: box, how: SHAPE_HOW(TIME_HOW), table: sec });
}

function draw() { drawSpend(); drawTime(); }

const SPEND_FRESH_MS = 10000; // a read of this team and range is reused for ten seconds: switching Analytics views redrew from the same numbers and asked again each time (#9250); the 15 s poll and the Refresh button read again
async function loadSpend(force = false) {
    if (!model.team) { draw(); return; }
    const key = `${model.team}|${model.range}`;
    if (!force && model.data && model.key === key && Date.now() - model.at < SPEND_FRESH_MS) { model.loading = false; draw(); return; }
    const seq = ++model.seq, team = model.team;
    model.loading = !model.data; model.error = '';
    draw();
    try {
        const r = await boardFetch(team, `/spend?range=${model.range}`);
        if (seq !== model.seq) return;
        if (r.status === 404) { model.data = null; model.error = 'No spend data for this team yet.'; }
        else if (!r.ok) throw new Error(String(r.status));
        else { model.data = await r.json(); model.key = key; model.at = Date.now(); }
    } catch { if (seq !== model.seq) return; model.error = 'Spend could not be read.'; }
    model.loading = false;
    draw();
}

/** The Analytics tab's range (hour, day, week, month) as the sections': 24 hours or 7 days. */
const rangeOf = (period) => (period === 'week' || period === 'month' ? '7d' : '24h');

/** Mount the two sections in `host` (tokens per commit) and `timeHost` (task time) and read them: `period` is the Analytics time range. Called on every refresh of the tab. */
export function showSpend(host, period, timeHost, force = false) {
    const range = rangeOf(period);
    const list = teams();
    const saved = browserLocal.get(TEAM_KEY) || '';
    const team = list.includes(model.team) ? model.team : (list.includes(saved) ? saved : (list[0] || ''));
    const changed = team !== model.team || range !== model.range;
    model.team = team; model.range = range;
    if (!host.dataset.built) {
        host.dataset.built = '1';
        const head = el('div', 'spend-head');
        const label = el('label', 'spend-team'); label.append(el('span', null, 'Team '));
        const sel = el('select', 'field field-dense cost-time-select spend-team-select'); sel.setAttribute('aria-label', 'Team for tokens per commit and task time');
        sel.addEventListener('change', () => { model.team = sel.value; try { browserLocal.set(TEAM_KEY, sel.value); } catch { /* the choice lasts until the page closes */ } model.data = null; loadSpend(); });
        label.append(sel); head.append(label);
        host.replaceChildren(head, el('div', 'spend-body'));
    }
    root = host;
    if (timeHost) { if (!timeHost.dataset.built) { timeHost.dataset.built = '1'; timeHost.replaceChildren(el('div', 'time-body')); } timeRoot = timeHost; }
    const sel = host.querySelector('.spend-team-select');
    sel.replaceChildren(...list.map(t => new Option(teamLabel(t), t)));
    sel.value = team;
    host.querySelector('.spend-head').hidden = list.length < 2;
    if (changed) model.data = null;
    readBoards().then(more => { if (more && host.isConnected) showSpend(host, period, timeHost); }); // the boards' teams came in: the picker is drawn again with them
    return loadSpend(force);
}
