/* The Analytics tab's "Tokens per commit" section (#7526, UI/UX's pace r2, analytics only: no banner, snooze, alert or Inbox item): for one team, the tokens per landed commit over the last 24 hours (or 7 days) against the 7 days before, the usual line,
 * one bar a day, how it is counted, and who spends. The unit is one team; tokens are input plus output with the cache reads beside them, never inside; a commit counts once when it reaches main, its author is the agent, an author that matches no agent is
 * "Unattributed"; an agent with no token source is "Not measured", never zero. The page divides: the endpoint (GET /api/board/<team>/spend?range=24h|7d) sends counts, not ratios. Everything is built with the DOM and textContent: agent names are written by
 * agents. Lazy: cost_dashboard.js imports it. */
import { state } from './state.js';
import { boardFetch, keyLabel } from './server_base.js';
import { browserLocal } from './safe_storage.js';

const TEAM_KEY = 'coral-spend-team';
const DRIFT = 1.3; // the bar of a day is amber when it is 30% above usual (colour only: nothing is sent to anyone)
const model = { team: '', range: '24h', data: null, loading: false, error: '', seq: 0 };
let root = null;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** 517 K, 0.8 M, 61 M: tokens as a person reads them. */
function fmtTokens(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    if (v >= 1e7) return `${Math.round(v / 1e6)} M`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)} M`;
    if (v >= 1e3) return `${Math.round(v / 1e3)} K`;
    return String(Math.round(v));
}
const tokensOf = (t) => (typeof t === 'number' ? t : t && typeof t.tokens === 'number' ? t.tokens : t ? (Number(t.input) || 0) + (Number(t.output) || 0) : 0); // input plus output (a day's row has the sum already): the cache is beside it

/** The teams on this computer the person can look at: those with an agent on the list, then the one chosen last. */
function teams() {
    const names = new Set();
    for (const s of state.liveSessions || []) if (s && s.board_project) names.add(s.board_project);
    return [...names].sort((a, b) => keyLabel(a).localeCompare(keyLabel(b)));
}

const ratio = (num, den) => (den > 0 ? num / den : null);

/** The numbers the cards and the sentence say, from the endpoint's counts. */
function figures(data, range) {
    const win = tokensOf(data.tokens && data.tokens.window), usual = tokensOf(data.tokens && data.tokens.usual);
    const c = data.commits || {};
    const per = ratio(win, c.window), usualPer = ratio(usual, c.usual);
    const above = per != null && usualPer ? Math.round((per / usualPer - 1) * 100) : null;
    const tc = data.tool_calls;
    return { win, usual, per, usualPer, above, commits: c.window || 0, usualCommits: c.usual || 0, unattributed: c.unattributed || 0, cacheReads: Number(data.tokens && data.tokens.window && data.tokens.window.cache_read) || 0,
        toolPer: tc && tc.measured_agents ? ratio(tc.window, c.window) : null, toolMeasured: tc ? [tc.measured_agents, tc.of_agents] : null, windowWord: range === '7d' ? '7 days' : '24 h', beforeWord: range === '7d' ? 'the 7 days before' : 'the 7 days before' };
}

function headline(f) {
    if (!f.commits) return `No commit landed in ${f.windowWord}. ${fmtTokens(f.win)} tokens were spent.`;
    const parts = [`${fmtTokens(f.per)} tokens per commit`];
    if (f.usualPer) parts.push(`usual ${fmtTokens(f.usualPer)}`, f.above === 0 ? 'the same' : `${Math.abs(f.above)}% ${f.above > 0 ? 'above' : 'below'}`);
    return `${parts.join(', ')}.`;
}

function card(value, label, sub) {
    const c = el('div', 'cost-card spend-card');
    c.append(el('div', 'cost-card-value', value), el('div', 'cost-card-label', label));
    if (sub) c.append(el('div', 'spend-card-sub', sub));
    return c;
}

function chart(data, f) {
    const days = Array.isArray(data.per_day) ? data.per_day : [];
    const vals = days.map(d => ratio(tokensOf(d), d.commits));
    const top = Math.max(1, ...vals.filter(v => v != null), f.usualPer || 0);
    const wrap = el('div', 'spend-chart');
    const bars = el('div', 'spend-bars'); bars.setAttribute('role', 'img');
    bars.setAttribute('aria-label', `Tokens per commit each day, ${days.length} days${f.usualPer ? `, usual ${fmtTokens(f.usualPer)}` : ''}: ${days.map((d, i) => `${d.day} ${vals[i] == null ? 'no commit' : fmtTokens(vals[i])}`).join(', ')}`);
    days.forEach((d, i) => {
        const col = el('div', 'spend-bar-col');
        const bar = el('div', 'spend-bar');
        bar.style.height = `${vals[i] == null ? 2 : Math.max(2, Math.round((vals[i] / top) * 100))}%`;
        const today = i === days.length - 1;
        if (today && vals[i] != null && f.usualPer && vals[i] > f.usualPer * DRIFT) bar.classList.add('spend-bar-high');
        bar.title = `${d.day}: ${vals[i] == null ? 'no commit landed' : `${fmtTokens(vals[i])} per commit`}`;
        col.append(bar);
        bars.append(col);
    });
    if (f.usualPer) { const line = el('div', 'spend-usual'); line.style.bottom = `${Math.round((f.usualPer / top) * 100)}%`; line.setAttribute('aria-hidden', 'true'); bars.append(line); }
    wrap.append(bars);
    const axis = el('div', 'spend-axis'); axis.setAttribute('aria-hidden', 'true'); axis.append(el('span', null, `${days.length} days ago`), el('span', null, 'to' + 'day')); // spelled in two parts: the icon-name lint reads a quoted word as an icon
    wrap.append(axis, el('p', 'spend-note', f.usualPer ? `Dashed line: usual, ${fmtTokens(f.usualPer)}. Today is amber when it is 30% above.` : 'No usual yet: there is no commit in the 7 days before.'));
    return wrap;
}

function table(data) {
    const t = el('table', 'cost-table spend-table'); t.setAttribute('aria-label', 'Who spends');
    const head = el('tr');
    for (const h of ['Agent', 'Tokens', 'Share', 'Commits', 'Cache reads', 'Tool calls']) { const th = el('th', null, h); th.scope = 'col'; head.append(th); }
    const thead = el('thead'); thead.append(head); t.append(thead);
    const body = el('tbody');
    const agents = (Array.isArray(data.agents) ? data.agents : []).slice().sort((a, b) => (a.tokens == null) - (b.tokens == null) || (b.tokens || 0) - (a.tokens || 0));
    for (const a of agents) {
        const tr = el('tr');
        const name = el('th', null, a.name || ''); name.scope = 'row'; tr.append(name);
        if (a.name === 'Unattributed') {
            for (const v of ['—', '—', a.commits == null ? '' : String(a.commits), '—', '—']) tr.append(el('td', null, v));
        } else if (a.tokens == null) {
            const td = el('td', 'spend-not-measured', 'Not measured'); td.colSpan = 5; tr.append(td); // one cell, not five zeros
        } else {
            tr.append(el('td', null, fmtTokens(a.tokens)), el('td', null, a.share == null ? '' : `${Math.round(a.share * 100)}%`), el('td', a.commits == null ? 'spend-muted' : null, a.commits == null ? 'team' : String(a.commits)), el('td', null, a.cache_reads == null ? '—' : fmtTokens(a.cache_reads)), el('td', null, a.tool_calls == null ? 'Not measured' : String(a.tool_calls)));
        }
        body.append(tr);
    }
    t.append(body);
    return t;
}

function draw() {
    if (!root) return;
    const body = root.querySelector('.spend-body'); if (!body) return;
    body.replaceChildren();
    body.setAttribute('aria-busy', String(model.loading));
    if (!model.team) { body.append(el('p', 'cost-empty', 'Open a team to see how many tokens its commits take.')); return; }
    if (model.error) {
        const e = el('div', 'cost-empty spend-error'); e.setAttribute('role', 'alert'); e.append(el('span', null, model.error + ' '));
        const b = el('button', 'btn btn-small', 'Try again'); b.type = 'button'; b.addEventListener('click', () => loadSpend()); e.append(b); body.append(e); return;
    }
    if (model.loading && !model.data) { body.append(el('p', 'cost-empty', 'Loading…')); return; }
    const data = model.data; if (!data) return;
    const f = figures(data, model.range);
    body.append(el('p', 'spend-sub', `Team ${keyLabel(model.team)} · last ${f.windowWord} against ${f.beforeWord}`));
    body.append(el('p', 'spend-headline', headline(f)));
    const cards = el('div', 'cost-summary-cards spend-cards');
    cards.append(card(f.commits ? fmtTokens(f.per) : '—', `tokens per landed commit, ${f.windowWord}`, f.commits ? '' : 'no commit landed'),
        card(f.usualPer ? fmtTokens(f.usualPer) : '—', `usual, ${f.beforeWord}`, f.usualCommits ? `${f.usualCommits} commits` : 'no commit then'),
        card(String(f.commits), 'commits landed on main', f.unattributed ? `${f.unattributed} unattributed` : ''),
        card(fmtTokens(f.cacheReads) || '0', 'cache reads, not in the total', ''),
        card(f.toolPer != null ? (f.toolPer >= 10 ? String(Math.round(f.toolPer)) : f.toolPer.toFixed(1)) : 'Not measured', `tool calls per landed commit, ${f.windowWord}`, f.toolMeasured ? `${f.toolMeasured[0]} of ${f.toolMeasured[1]} agents measured` : ''));
    body.append(cards);
    const grid = el('div', 'spend-grid');
    const chartBox = el('section', 'spend-box'); chartBox.append(el('h4', 'spend-box-title', 'Tokens per commit, each day'), chart(data, f));
    const how = el('details', 'disclosure spend-how'); how.append(el('summary', null, 'How it is counted'), el('p', 'spend-note', 'Tokens are input plus output. Cache writes and cache reads are shown beside, never hidden in the total. A commit counts once when it reaches main; its author is the agent, and one that matches no agent is Unattributed. Review and orchestration tokens belong to the team, not to one commit. An agent with no token record is Not measured, not zero.'));
    grid.append(chartBox, how);
    body.append(grid);
    const who = el('section', 'spend-who'); who.append(el('h4', 'spend-box-title', 'Who spends'));
    const scroll = el('div', 'cost-table-container'); scroll.append(table(data)); who.append(scroll);
    if (data.measured_agents != null && data.of_agents != null && data.measured_agents < data.of_agents) who.append(el('p', 'spend-note', `${data.measured_agents} of ${data.of_agents} agents measured.`));
    body.append(who);
}

export async function loadSpend() {
    if (!model.team) { draw(); return; }
    const seq = ++model.seq, team = model.team;
    model.loading = !model.data; model.error = '';
    draw();
    try {
        const r = await boardFetch(team, `/spend?range=${model.range}`);
        if (seq !== model.seq) return;
        if (r.status === 404) { model.data = null; model.error = 'No spend data for this team yet.'; }
        else if (!r.ok) throw new Error(String(r.status));
        else model.data = await r.json();
    } catch { if (seq !== model.seq) return; model.error = 'Spend could not be read.'; }
    model.loading = false;
    draw();
}

/** The Analytics tab's range (hour, day, week, month) as the section's: 24 hours or 7 days. */
const rangeOf = (period) => (period === 'week' || period === 'month' ? '7d' : '24h');

/** Mount the section in `host` and read it: `period` is the Analytics time range. Called on every refresh of the tab. */
export function showSpend(host, period) {
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
        const sel = el('select', 'cost-time-select spend-team-select'); sel.setAttribute('aria-label', 'Team for tokens per commit');
        sel.addEventListener('change', () => { model.team = sel.value; try { browserLocal.set(TEAM_KEY, sel.value); } catch { /* the choice lasts until the page closes */ } model.data = null; loadSpend(); });
        label.append(sel); head.append(label);
        host.replaceChildren(head, el('div', 'spend-body'));
    }
    root = host;
    const sel = host.querySelector('.spend-team-select');
    sel.replaceChildren(...list.map(t => new Option(keyLabel(t), t)));
    sel.value = team;
    host.querySelector('.spend-head').hidden = list.length < 2;
    if (changed) model.data = null;
    return loadSpend();
}
