/* The Cost page's Export CSV (#21021, feature bets stage 1, the approved mock #21017): the cost of the range by task or by goal, as a file for billing a client. It is built from the very rows the page's By task and By goal tables draw
 * (cost_dashboard.js hands them over), so the Total row is the page's Total cost. A cell that starts like a formula is written as text (a task's title is written by an agent): a spreadsheet does not run it. Built with the DOM and textContent. */
import { closeOnBackdropAndEscape, releaseEscape } from './dialog_close.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export const EXPORT_TASK_HEAD = ['Task', 'Task ID', 'Team', 'Status', 'Agent', 'Started', 'Finished', 'Cost (USD)', 'New input tokens', 'Output tokens', 'Cache read tokens', 'Cache write tokens'];
export const EXPORT_GOAL_HEAD = ['Goal', 'Goal ID', 'Tasks', 'Cost (USD)', 'New input tokens', 'Output tokens', 'Cache read tokens', 'Cache write tokens'];
const RANGE_WORDS = { hour: 'last hour', day: 'last 24 hours', week: 'last 7 days', month: 'last 30 days' };

/** One text cell: quoted when it has a comma, quote or line break, and a leading = + - @ tab or return made a text with an apostrophe in front. */
export function csvText(v) {
    let s = v == null ? '' : String(v).replace(/\r\n?|\n/g, ' ');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** One figure: a plain number (a refund's negative cost stays a number, never a text). */
export const csvNumber = v => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '0');

const sum = (rows, f) => rows.reduce((n, r) => n + (Number(r[f]) || 0), 0);
const FIGURES = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];

/** The CSV of the tasks of the range (and the cost no task carries, when there is one), with a Total row. */
export function taskCsv(tasks, rest) {
    const rows = rest ? [...tasks, rest] : tasks;
    const line = t => [csvText(t.title || ''), t.untasked ? '' : csvText(t.id), csvText(t.board_id || ''), csvText(t.untasked ? '' : t.status || ''), csvText(t.assigned_to || ''), csvText(t.claimed_at || ''), csvText(t.completed_at || ''), csvNumber(t.cost_usd || 0), ...FIGURES.map(f => csvNumber(t[f] || 0))].join(',');
    return [EXPORT_TASK_HEAD.map(csvText).join(','), ...rows.map(line), ['Total', '', '', '', '', '', '', csvNumber(sum(rows, 'cost_usd')), ...FIGURES.map(f => csvNumber(sum(rows, f)))].join(',')].join('\r\n') + '\r\n';
}
/** The CSV of the goals of the range (the rows the By goal table draws), with a Total row. */
export function goalCsv(goals) {
    const line = g => [csvText(g.title || ''), g.untasked || !g.id || g.id < 0 ? '' : csvText(g.id), csvNumber(g.tasks || 0), csvNumber(g.cost_usd || 0), ...FIGURES.map(f => csvNumber(g[f] || 0))].join(',');
    return [EXPORT_GOAL_HEAD.map(csvText).join(','), ...goals.map(line), ['Total', '', csvNumber(sum(goals, 'tasks')), csvNumber(sum(goals, 'cost_usd')), ...FIGURES.map(f => csvNumber(sum(goals, f)))].join(',')].join('\r\n') + '\r\n';
}

/** The file's name: what it is by, the range and the day. */
export function exportName(by, period, team, now = new Date()) {
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return `coral-cost-by-${by}-${period || 'day'}${team ? '-' + team.replace(/[^A-Za-z0-9._-]/g, '_') : ''}-${day}.csv`;
}

/** Hands the file to the browser as a download. */
export function download(name, text) {
    const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The chooser (by task or by goal, with the range and team said) and the download. model(by) is { csv } for the page's rows now. */
export function openExportDialog({ period, team, model }) {
    document.getElementById('cost-export-modal')?.remove();
    const opener = document.activeElement;
    const overlay = el('div', 'modal'); overlay.id = 'cost-export-modal';
    const box = el('div', 'modal-content dlg-confirm'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'cost-export-title');
    const title = el('h3', '', 'Export cost as CSV'); title.id = 'cost-export-title';
    const radios = el('div', 'cost-export-choices');
    const choice = (value, label, checked) => {
        const l = el('label', 'cost-export-choice'), r = el('input'); r.type = 'radio'; r.name = 'cost-export-by'; r.value = value; r.checked = checked;
        l.append(r, document.createTextNode(label)); return l;
    };
    radios.append(choice('task', 'By task', true), choice('goal', 'By goal', false));
    const range = RANGE_WORDS[period] || RANGE_WORDS.day;
    const note = el('p', 'cost-export-note', team ? `The range above (${range}) and team ${team}: that team's tasks.` : `The range above: the ${range}. Totals match this page.`);
    const actions = el('div', 'modal-actions');
    const cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button';
    const go = el('button', 'btn btn-primary', 'Download CSV'); go.type = 'button';
    actions.append(cancel, go);
    box.append(title, radios, note, actions); overlay.append(box);
    const close = () => { releaseEscape(overlay); overlay.remove(); if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus(); };
    cancel.addEventListener('click', close);
    go.addEventListener('click', () => {
        const by = overlay.querySelector('input[name="cost-export-by"]:checked').value;
        const out = model(by);
        download(exportName(by, period, team), out.csv);
        close();
    });
    closeOnBackdropAndEscape(overlay, close);
    document.body.appendChild(overlay);
    go.focus();
}
