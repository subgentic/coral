/* The groups of a sidebar list that is not the Agents one (#7443), and the table a group's name opens in the centre.
 *
 * A group header is a chevron, the group's name and a count. The chevron only folds the group; the name opens the whole group in the centre as a table (a real table: column
 * headers, the first column the button that opens the item, a dash for an empty cell). The item's page says "← <group>" to go back to the table (backLinkHtml). The Agents list's teams already do
 * this (a team's name opens the team, its chevron folds: group_cards.js); this is the same header for the tabs that have groups of their own (Chats by day, Jobs by state).
 *
 * A tab registers a source: { keys(): the group keys as drawn, redraw(): draws the list again, table(key): { title, columns, rows }, isEmpty(): whether the tab's centre is
 * its empty page, showList() and empty(): back to the tab's own page }. A table may also carry { extra: { action, label, icon, title } }, one action button in its head; { chips: [{ action, data, label, count, pressed }], chipsLabel } filter chips above it; { empty: { line, hint } } for the line it is replaced by when it has no row; and { note } a line under it. A row is { title, action: the delegated action the first cell's button names, data: the data-* values it carries (name: value),
 * cells: the other cells as text, or a button { action, data, label, aria } }. */
import { browserLocal } from './safe_storage.js';
import { escapeHtml, escapeAttr, showView } from './utils.js';
import { onViewShown } from './view_switch.js';
import { registerActions, textOf } from './actions.js';
import { setHidden, setTitle, setAttr, setData } from './dom_write.js';
import { isPhoneLayout } from './phone_layout.js';

const sources = new Map();
const KEY = kind => `coral-sidebar-groups-${kind}`;

export function registerGroupSource(kind, source) { sources.set(kind, source); }

function folded(kind) {
    try { const v = JSON.parse(browserLocal.get(KEY(kind)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function isGroupFolded(kind, key) { return folded(kind).includes(key); }

function setFolded(kind, keys) { browserLocal.set(KEY(kind), JSON.stringify(keys)); }

export function toggleGroupFold(kind, key) {
    const keys = folded(kind), at = keys.indexOf(key);
    if (at >= 0) keys.splice(at, 1); else keys.push(key);
    setFolded(kind, keys);
    sources.get(kind)?.redraw();
}

/** Fold every group of the tab, or open them all (the header's one toggle); when they are all folded already it opens them. */
export function toggleAllGroupFolds(kind) {
    const src = sources.get(kind);
    if (!src) return;
    const keys = src.keys();
    const all = keys.length > 0 && keys.every(k => isGroupFolded(kind, k));
    setFolded(kind, all ? [] : keys);
    src.redraw();
}

const CHEVRON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';

/** The header row of a group, the shape of a team's in the Agents list. */
export function groupHeaderHtml(kind, key, label, count) {
    const isFolded = isGroupFolded(kind, key);
    const chevronName = `${isFolded ? 'Expand' : 'Collapse'} ${label}`;
    const attrs = `data-kind="${escapeAttr(kind)}" data-group="${escapeAttr(key)}"`;
    return `<li class="session-group-header sgroup-header" data-group-name="${escapeAttr(kind + ':' + key)}" data-on-click="sgroup-open" ${attrs} data-on-keydown="sgroup-key" role="button" tabindex="0" aria-label="${escapeAttr('Open ' + label + ' as a table')}">`
        + `<button type="button" class="group-chevron" data-on-click="sgroup-chevron" ${attrs} aria-expanded="${escapeAttr(isFolded ? 'false' : 'true')}" aria-label="${escapeAttr(chevronName)}" title="${escapeAttr(chevronName)}">${CHEVRON}</button>`
        + `<div class="group-header-text"><div class="group-name-line"><span class="group-name-text">${escapeHtml(label)}</span><span class="session-group-count">${Number(count)}</span></div></div></li>`;
}

/** The header's Collapse / Expand toggle of a tab: there while the list has groups, and says (name, icon) what it does next. */
export function syncPaneGroupToggle(kind) {
    const src = sources.get(kind);
    const btn = document.querySelector(`.sidebar-header[data-header="${kind}"] [data-group-toggle]`);
    if (!src || !btn) return;
    const keys = src.keys();
    const allFolded = keys.length > 0 && keys.every(k => isGroupFolded(kind, k));
    const label = allFolded ? 'Expand all groups' : 'Collapse all groups';
    setHidden(btn, keys.length === 0);
    setTitle(btn, label); setAttr(btn, 'aria-label', label);
    setData(btn, 'next', allFolded ? 'expand' : 'collapse');
}

// ── The table in the centre ──────────────────────────────────────────────

let open = null;     // { kind, key }: the table on screen

const dash = '<span aria-hidden="true">&mdash;</span><span class="sr-only">none</span>'; // an empty cell: the mark is drawn, a reader hears "none" (a span with only an aria-label is not announced)

/** The actions a row's button may name, each as the literal attribute: a source names one of these, never its own text. */
const ROW_ACTION_ATTR = { 'history-open': 'data-on-click="history-open"', 'board-open': 'data-on-click="board-open"', 'job-select': 'data-on-click="job-select"', 'doc-open': 'data-on-click="doc-open"', 'wf-select': 'data-on-click="wf-select"',
    'inbox-agent-open': 'data-on-click="inbox-agent-open"', 'inbox-task-open': 'data-on-click="inbox-task-open"', 'inbox-saved-open': 'data-on-click="inbox-saved-open"' };
/** The actions a table's own button cell may name (Workflows: Run), the same way. */
const CELL_ACTION_ATTR = { 'wf-trigger': 'data-on-click="wf-trigger"', 'inbox-saved-done': 'data-on-click="inbox-saved-done"', 'inbox-goal-open': 'data-on-click="inbox-goal-open"' };
/** The filter chips above a table (the Inbox's Saved: Open and Done, with counts), the same way. */
const CHIP_ACTION_ATTR = { 'inbox-saved-chip': 'data-on-click="inbox-saved-chip"' };

/** The one action a table may carry in its head (Docs: "Copy docs line for agents"), as the literal attribute: a source names one of these. */
const EXTRA_ACTION_ATTR = { 'docs-copy-agent-line': 'data-on-click="docs-copy-agent-line"', 'wf-build-agent': 'data-on-click="wf-build-agent"' };
function extraHtml(x) {
    if (!x || !EXTRA_ACTION_ATTR[x.action]) return '';
    return `<button type="button" class="btn btn-small group-table-extra" ${EXTRA_ACTION_ATTR[x.action]} title="${escapeAttr(x.title || '')}"><span class="material-icons" aria-hidden="true">${escapeHtml(x.icon || '')}</span> ${escapeHtml(x.label)}</button>`;
}

/** The data-* attributes of a row's button, from the names the source wrote and the values it was given. */
function dataAttrs(data) { return Object.entries(data || {}).map(([k, v]) => `data-${escapeAttr(k)}="${escapeAttr(v)}"`).join(' '); }

/** A cell: text (a dash when empty), or { action, data, label, aria }: a small button the table's source names. */
function cellHtml(c) {
    if (c && typeof c === 'object') {
        if (!CELL_ACTION_ATTR[c.action]) return `<td>${dash}</td>`;
        return `<td><button type="button" class="btn btn-small group-table-cell-btn" ${CELL_ACTION_ATTR[c.action]} ${dataAttrs(c.data)} aria-label="${escapeAttr(c.aria || c.label)}">${escapeHtml(c.label)}</button></td>`;
    }
    return `<td>${c ? escapeHtml(c) : dash}</td>`;
}

function chipsHtml(t) {
    if (!t.chips || !t.chips.length) return '';
    return `<div class="group-table-chips" role="group" aria-label="${escapeAttr(t.chipsLabel || 'Show')}">${t.chips.filter(c => CHIP_ACTION_ATTR[c.action]).map(c => `<button type="button" class="group-chip" ${CHIP_ACTION_ATTR[c.action]} ${dataAttrs(c.data)} aria-pressed="${escapeAttr(c.pressed ? 'true' : 'false')}">${escapeHtml(c.label)} <span class="group-chip-count">${Number(c.count)}</span></button>`).join('')}</div>`;
}

function tableHtml(t, kind, key) {
    const head = t.columns.map(c => `<th scope="col">${escapeHtml(c)}</th>`).join('');
    const rows = t.rows.map(r => `<tr><td><button type="button" class="group-table-link" ${ROW_ACTION_ATTR[r.action] || ''} ${dataAttrs(r.data)}>${escapeHtml(r.title)}</button></td>`
        + r.cells.map(cellHtml).join('') + '</tr>').join('');
    const top = `<div class="group-table-head"><h2 id="group-table-title" tabindex="-1">${escapeHtml(t.title)}</h2><span class="session-group-count">${t.rows.length}</span>${extraHtml(t.extra)}</div>${chipsHtml(t)}`;
    // A group with nothing in it says so in one line (its chips, if it has them, stay: they are how the list is widened)
    if (!t.rows.length && t.empty) return top + `<div class="empty-pane"><p class="empty-line">${escapeHtml(t.empty.line)}</p>${t.empty.hint ? `<p class="empty-hint">${escapeHtml(t.empty.hint)}</p>` : ''}</div>`;
    return top + `<div class="group-table-scroll"><table class="group-table" aria-labelledby="group-table-title"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
        + (t.note ? `<p class="empty-hint group-table-note">${escapeHtml(t.note)}</p>` : '');
}

function drawTable() {
    const host = document.getElementById('group-table-view');
    const src = open && sources.get(open.kind);
    const t = src && src.table(open.key);
    if (!host || !t) return false;
    const html = (isPhoneLayout() ? `<button type="button" class="btn btn-small group-table-back" data-on-click="sgroup-list" data-kind="${escapeAttr(open.kind)}">Back to the list</button>` : '') + tableHtml(t, open.kind, open.key);
    host.dataset.group = open.kind + ':' + open.key; // which table is on screen (saved.js asks for the Inbox's Saved)
    if (host.dataset.drawn !== html) { host.innerHTML = html; host.dataset.drawn = html; } // a redraw of what is there would drop the focus from a row the keyboard is on
    return true;
}

/** Opens a group as a table in the centre. */
export function openGroupTable(kind, key) {
    open = { kind, key };
    if (!drawTable()) { open = null; return false; }
    showView('group-table-view');
    document.querySelectorAll('.sidebar-pane .session-list > li.active').forEach(li => { li.classList.remove('active'); li.querySelector('[aria-current]')?.removeAttribute('aria-current'); });
    return true;
}

/** The list was drawn: the table on screen follows it (a group that has gone leaves it for the first group, or for the tab's empty page when there is none); and a tab that shows its
 *  empty page (no item open) opens on its first group's table. A phone's list is the page itself, so it keeps it. */
export function refreshGroupTable(kind) {
    const src = sources.get(kind);
    if (open && open.kind === kind) {
        const host = document.getElementById('group-table-view');
        if (!host || host.style.display === 'none') { open = null; return; }
        if (drawTable()) return;
        open = null;
        if (!openFirstGroupTable(kind)) src?.empty?.();
        return;
    }
    if (!open && src?.isEmpty?.() && !isPhoneLayout()) openFirstGroupTable(kind);
}

/** The tab opens on its first group's table, when it has one. */
export function openFirstGroupTable(kind) {
    const src = sources.get(kind);
    const first = src && src.keys()[0];
    return first != null ? openGroupTable(kind, first) : false;
}

// The view on screen is not the table: it is not open any more.
onViewShown(id => { if (id !== 'group-table-view') open = null; });

/** The link at the top of an item's page back to its group's table ("← Today"): the text link of the style guide, not a button of its own kind. */
export function backLinkHtml(kind, key, label, id) {
    return `<button type="button" class="group-back"${id ? ` id="${escapeAttr(id)}"` : ''} data-on-click="sgroup-open" data-kind="${escapeAttr(kind)}" data-group="${escapeAttr(key)}">\u2190 ${escapeHtml(label)}</button>`;
}

/** Sets an item page's static back link (history_session.html's #history-back) to a group, or hides it for an item that has none. */
export function setBackLink(id, kind, group) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !group;
    if (!group) return;
    el.dataset.kind = kind; el.dataset.group = group.key;
    el.textContent = `\u2190 ${group.label}`;
}

registerActions({
    'sgroup-open': el => { const kind = textOf(el.dataset.kind), key = textOf(el.dataset.group); if (kind && key && !openGroupTable(kind, key)) sources.get(kind)?.showList?.(); }, // a group that has gone (a filter, a fold of the list) leaves for the tab's own page
    'sgroup-chevron': (el, event) => { event.stopPropagation(); const kind = textOf(el.dataset.kind), key = textOf(el.dataset.group); if (kind && key) toggleGroupFold(kind, key); },
    'sgroup-key': (el, event) => {
        if (event.target !== el || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        const kind = textOf(el.dataset.kind), key = textOf(el.dataset.group);
        if (kind && key) openGroupTable(kind, key);
    },
    'sgroup-list': el => { const kind = textOf(el.dataset.kind); open = null; sources.get(kind)?.showList?.(); },
});
