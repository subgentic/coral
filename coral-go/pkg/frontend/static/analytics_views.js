/* The Analytics tab's list of views (#7473, UI/UX's part-2 audit): the sidebar lists the views (Overview, one per table, the two per-team ones) and the page shows the one chosen, so the
 * page is one view at a time under a 20/700 title: its name, the time range and the live mark under it. Every section of the page carries data-cview, and the page's data-view
 * says which one is on screen (cost_dashboard.css shows only that one). The time range is a select in the page's header beside Refresh (#7666). On a phone the list is the page and a view is the screen after it. */
import { escapeHtml, escapeAttr } from './utils.js';
import { isPhoneLayout } from './phone_layout.js';
import { setText } from './dom_write.js';
import { state } from './state.js';
import { note } from './nav.js';

export const VIEWS = [
    { key: 'overview', label: 'Overview' },
    { key: 'provider', label: 'By provider' },
    { key: 'model', label: 'By model' },
    { key: 'thinking', label: 'By thinking level' },
    { key: 'team', label: 'By team' },
    { key: 'agent', label: 'By agent' },
    { key: 'branch', label: 'By branch' },
    { key: 'task', label: 'By task' },
    { key: 'calls', label: 'Tool and API calls' },
    { key: 'per-commit', label: 'Tokens per commit' },
    { key: 'task-time', label: 'Task time' },
    { key: 'agent-detail', label: 'Agent', hidden: true }, // one agent over the range: opened from By agent's Details, not listed (analytics_agent.js, #7930)
];

let current = 'overview';
let query = '';

const page = () => document.getElementById('cost-dashboard-view');

function shown() {
    const q = query.trim().toLowerCase();
    const listed = VIEWS.filter(v => !v.hidden);
    return q ? listed.filter(v => v.label.toLowerCase().includes(q)) : listed;
}

/** The sidebar's list: one button per view, the open one marked. */
function drawViews() {
    const list = document.getElementById('cost-nav-list');
    if (!list) return;
    const held = list.contains(document.activeElement) ? document.activeElement.dataset.view : null; // the list is drawn again: the keyboard stays on its row
    const rows = shown(), on = current === 'agent-detail' ? 'agent' : current; // an agent's page is under By agent
    list.innerHTML = rows.map(v => `<li class="session-list-item${escapeAttr(v.key === on ? ' active' : '')}"><button type="button" class="row-btn"${v.key === on ? ' aria-current="true"' : ''} data-on-click="analytics-view" data-view="${escapeAttr(v.key)}">${escapeHtml(v.label)}</button></li>`).join('')
        || '<li class="empty-state empty-state-tight">No view matches the search.</li>';
    if (held) list.querySelector(`.row-btn[data-view="${CSS.escape(held)}"]`)?.focus({ preventScroll: true });
}

export function filterViews(text) { query = String(text || ''); drawViews(); }

/** The time range as the page says it under the title ("Last 24 hours"), from the header's select. */
export function syncRangeLine() {
    const sel = document.getElementById('cost-time-range');
    const opt = sel && sel.options[sel.selectedIndex];
    if (opt) setText(document.getElementById('cost-range-text'), opt.textContent);
}

/** Shows a view: the page's data-view, its title and the list's marks; on a phone it is the screen after the list. */
export function selectView(key, { focus = false, fromHistory = false } = {}) {
    const v = VIEWS.find(x => x.key === key) || VIEWS[0];
    current = v.key;
    state.analyticsView = v.key;
    if (!fromHistory) note({ view: 'analytics', sub: v.key }); // the page is in the address (#8606): a click and Back stay in step
    const el = page();
    if (el) {
        el.dataset.view = v.key;
        if (isPhoneLayout()) el.setAttribute('data-phone-item', ''); else el.removeAttribute('data-phone-item');
    }
    for (const sec of document.querySelectorAll('#cost-dashboard-view [data-cview]')) sec.hidden = sec.dataset.cview !== v.key;
    setText(document.getElementById('cost-view-title'), v.label);
    syncRangeLine();
    drawViews();
    document.dispatchEvent(new CustomEvent('cost-view-change', { detail: v.key })); // a view with a chart over time reads it (cost_dashboard.js)
    const status = document.getElementById('cost-status');
    if (status && focus) setText(status, `Showing ${v.label}`);
    if (focus && isPhoneLayout()) document.getElementById('cost-view-title')?.focus({ preventScroll: true });
}

/** On a phone: back from a view to the list. */
export function phoneBack() {
    page()?.removeAttribute('data-phone-item');
    note({ view: 'analytics' }); // the list
    drawViews();
    (document.querySelector('#cost-nav-list .row-btn[aria-current="true"]') || document.querySelector('#cost-nav-list .row-btn'))?.focus({ preventScroll: true }); // the view just left, else the first
}

/** The tab was opened: the list is drawn, the view that was open stays (a phone starts at the list). */
export function showViews() {
    const el = page();
    const ask = state.analyticsAsk; // a route asked for a page (/analytics/<page>): read once
    state.analyticsAsk = null;
    if (el && isPhoneLayout()) el.removeAttribute('data-phone-item');
    selectView(ask ? ask.view : current, { fromHistory: true });
    if (el && isPhoneLayout() && !(ask && ask.open)) el.removeAttribute('data-phone-item');
}

/** An Analytics table on a phone is one line a row (#8982): its name column (the primary one, else the first) and the figure the table is read for (`keep`: column keys) stay, a row's own link stays (a column
 *  `details`), the others drop as the table narrows, the later columns first (the shared one-line table's dropAt, #8931). Returns the table's config to spread: { columns } as it was on a wider screen, or with
 *  oneLine and the columns' widths and dropAt on a phone. */
const DROP_AT = [28, 36, 52]; // the one-line table's thresholds in rem (data_table.css): the 52 goes first as the table narrows, the 28 last
export function phoneOneLine(columns, keep, lead) { // lead: the key of the column the table is about, when it is not the primary one or the first (By model's is Model, a filter column Provider comes before it)
    if (!isPhoneLayout()) return { columns };
    const first = lead || (columns.find(c => c.primary) || columns[0]).key, kept = new Set([first, 'details', ...keep]);
    let later = 0;
    return { oneLine: true, columns: columns.map(c => (kept.has(c.key)
        ? { ...c, width: c.key === first ? 'grow' : c.key === 'details' ? '4.5rem' : '6rem' }
        : { ...c, width: '6rem', dropAt: DROP_AT[Math.min(later++, 2)] })) };
}
