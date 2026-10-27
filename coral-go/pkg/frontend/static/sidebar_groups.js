/* The groups of a sidebar list that is not the Agents one (#7443), and the table a group's name opens in the centre.
 *
 * A group header is a chevron, the group's name and a count. The chevron only folds the group; the name opens the whole group in the centre as a table (a real table: column
 * headers, the first column the button that opens the item, a dash for an empty cell). The item's page says "← <group>" to go back to the table (backLinkHtml). The Agents list's teams already do
 * this (a team's name opens the team, its chevron folds: group_cards.js); this is the same header for the tabs that have groups of their own (Chats by day, Jobs by state).
 *
 * A tab registers a source: { keys(): the group keys as drawn, redraw(): draws the list again, table(key): { title, rows, node, signature }, isEmpty(): whether the tab's centre is
 * its empty page, showList() and empty(): back to the tab's own page }. A table may also carry { extra: { action, label, icon, title } }, one action button in its head; { chips: [{ action, data, label, count, pressed }], chipsLabel } filter chips above it; { empty: { line, hint } } for the line it is replaced by when it has no row; and { note } a line under it. Each source supplies its shared data_table node and a signature of its displayed rows. */
import { browserLocal } from './safe_storage.js';
import { escapeHtml, escapeAttr, showView } from './utils.js';
import { onViewShown } from './view_switch.js';
import { registerActions, textOf } from './actions.js';
import { setHidden, setTitle, setAttr, setData } from './dom_write.js';
import { isPhoneLayout } from './phone_layout.js';
import { importOnce } from './import_once.js';

const sources = new Map();
const TAB_NAME = { 'hub-inbox': 'Inbox', history: 'Chats', workflows: 'Workflows', jobs: 'Jobs', docs: 'Docs' }; // what a phone's way back from a table is named for (#7734)
const LAZY_SOURCES = { 'hub-inbox': './inbox_sidebar.js' }; // the module that registers a source this file may be asked to open before it has loaded
const LANDING = '*'; // the key of the page that lists every group (a source with landing: true)
const KEY = kind => `coral-sidebar-groups-${kind}`;

export function registerGroupSource(kind, source) { sources.set(kind, source); }

export { foldWayBack } from './way_back.js';

function folded(kind) {
    try { const v = JSON.parse(browserLocal.get(KEY(kind)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function isGroupFolded(kind, key) { return folded(kind).includes(key); }

function setFolded(kind, keys) { browserLocal.set(KEY(kind), JSON.stringify(keys)); }

function toggleGroupFold(kind, key) {
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

/** The page toolbar's create actions (#7723), as the literal attribute: a source names one of these. */
const TOOLBAR_ACTION_ATTR = { 'wf-create': 'data-on-click="wf-create"', 'job-new': 'data-on-click="job-new"', 'wf-build-agent': 'data-on-click="wf-build-agent"' };
const MORE_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

/** The page's one toolbar line (#7723, the team tabs' toolbar): the search field (the sidebar's own search, shown here and kept the same: typing in it types in the sidebar's), the chips of the first table
 *  (the Inbox's Saved: Open and Done), a More icon when the tab has a second way to create, and the tab's create action at the right. `bar` is the source's toolbar(): { search: { id, label },
 *  action: { name, label }, menu: { noun, items: [{ name, label }] } }. */
function toolbarHtml(bar, first) {
    const input = document.getElementById(bar.search.id);
    const value = input ? input.value : '';
    const label = (input && input.getAttribute('aria-label')) || bar.search.label; // the sidebar's field says what it searches in the open group (the Inbox: "Search saved messages"): the page's says the same
    const hint = (input && input.placeholder) || label;
    let html = `<div class="list-bar-search-wrap"><input type="search" class="list-bar-search gt-search" id="gt-search" data-on-input="sgroup-search" data-search="${escapeAttr(bar.search.id)}" placeholder="${escapeAttr(hint)}" aria-label="${escapeAttr(label)}" value="${escapeAttr(value)}" maxlength="200" autocomplete="off" spellcheck="false"></div>`;
    html += chipsHtml(first);
    const items = bar.menu ? bar.menu.items.filter(i => TOOLBAR_ACTION_ATTR[i.name]) : [];
    if (items.length) {
        const label = `More ${bar.menu.noun} actions`;
        html += `<span class="list-bar-more gt-menu"><button type="button" class="sidebar-collapse-btn list-bar-more-btn" id="gt-more" data-on-click="gt-menu-toggle" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}" aria-haspopup="menu" aria-expanded="false" aria-controls="gt-more-menu">${MORE_SVG}</button>`
            + `<div class="team-more-menu list-bar-more-menu" id="gt-more-menu" role="menu" aria-label="${escapeAttr(label)}" hidden>${items.map(i => `<button type="button" role="menuitem" ${TOOLBAR_ACTION_ATTR[i.name]}>${escapeHtml(i.label)}</button>`).join('')}</div></span>`;
    }
    if (bar.action && TOOLBAR_ACTION_ATTR[bar.action.name]) html += `<button type="button" class="btn btn-primary team-tb-action" ${TOOLBAR_ACTION_ATTR[bar.action.name]}>${escapeHtml(bar.action.label)}</button>`;
    return `<div class="list-bar-search-row team-toolbar-row gt-toolbar">${html}</div>`;
}

function chipsHtml(t) {
    if (!t.chips || !t.chips.length) return '';
    return `<div class="group-table-chips" role="group" aria-label="${escapeAttr(t.chipsLabel || 'Show')}">${t.chips.filter(c => CHIP_ACTION_ATTR[c.action]).map(c => `<button type="button" class="group-chip" ${CHIP_ACTION_ATTR[c.action]} ${dataAttrs(c.data)} aria-pressed="${escapeAttr(c.pressed ? 'true' : 'false')}">${escapeHtml(c.label)} <span class="group-chip-count">${Number(c.count)}</span></button>`).join('')}</div>`;
}

/** A table drawn somewhere other than the centre (the dock's Saved tab): `headless` leaves out its title row, the chips and the rows are the same. */
export function tableMarkup(t) { return tableHtml(t); }

let drawnTables = []; // the tables on screen, for a note's Retry to find its table (#8933)

function tableHtml(t, n = 0, lead = '', bar = false) {
    const tid = n ? `group-table-title-${n + 1}` : 'group-table-title'; // a page with several tables (the landing's groups, #7722): one title id each
    const count = t.count === undefined ? t.rows.length : t.count;
    // An Inbox folder page (t.noun, with its component toolbar): the title and the count are the first thing of the toolbar's one row (folderHead), not a row of their own (#8700)
    const inRow = !!(t.noun && bar && !n);
    const top = (t.headless || inRow ? lead : `<div class="group-table-head">${lead}<h2 id="${escapeAttr(tid)}" tabindex="-1">${escapeHtml(t.title)}</h2>${count == null ? '' : `<span class="session-group-count">${count}</span>`}${bar ? '' : extraHtml(t.extra)}</div>`) + (bar && !n ? '' : chipsHtml(t)); // the page's toolbar line has the first table's chips and the create actions
    // A table's quiet note (a computer that did not answer, the search note) and its Retry stay under an empty table too: the folder that is empty because a computer did not answer is the one that needs them (#8933)
    const note = t.note ? `<p class="empty-hint group-table-note">${escapeHtml(t.note)}${t.retry ? ` <button type="button" class="btn btn-small group-table-retry" data-on-click="sgroup-retry" data-table="${Number(n)}" aria-label="${escapeAttr('Retry reading ' + String(t.title).toLowerCase())}">Retry</button>` : ''}</p>` : '';
    // A group with nothing in it says so in one line (its chips, if it has them, stay: they are how the list is widened)
    if (!t.rows.length && t.empty) return top + `<div class="empty-pane"><p class="empty-line">${escapeHtml(t.empty.line)}</p>${t.empty.hint ? `<p class="empty-hint">${escapeHtml(t.empty.hint)}</p>` : ''}</div>` + note;
    return top + '<div class="group-table-node"></div>' + note;
}

/** An Inbox folder page's title and count, the first thing of its toolbar's one row (#8700): the h2 keeps the page's title id (the focus target when nothing else takes it). Drawn again only when its words change. */
function folderHead(node, t) {
    const row = node.querySelector('.list-bar-search-row');
    if (!row) return;
    const count = t.count === undefined ? t.rows.length : t.count, words = `${t.title}|${count}`;
    let head = row.querySelector(':scope > .inbox-folder-head');
    if (head && head.dataset.words === words) return;
    if (!head) { head = document.createElement('span'); head.className = 'inbox-folder-head'; row.prepend(head); }
    head.dataset.words = words;
    const h = document.createElement('h2'); h.id = 'group-table-title'; h.tabIndex = -1; h.textContent = t.title;
    head.replaceChildren(h);
    if (count != null) { const c = document.createElement('span'); c.className = 'session-group-count'; c.textContent = String(count); head.append(c); }
}

function drawTable() {
    const host = document.getElementById('group-table-view');
    const src = open && sources.get(open.kind);
    // the landing ('*') of a tab that says so (landing: true): every group's table, one under the other, each with its own head and count, so the page and the sidebar count the same items (#7722)
    const tables = !src ? [] : open.key === LANDING ? src.keys().map(k => src.table(k)).filter(Boolean).map((x, i) => (i ? { ...x, extra: undefined } : x)) : [src.table(open.key)].filter(Boolean);
    if (!host || !tables.length) return false;
    drawnTables = tables;
    // a phone's way back to the list is in the table's own title row, not a row of its own above it (#7722)
    // A source with a `lead` (the Inbox: its view list as one select, #7785) puts that on top of the table on a phone instead: the select is the way to the other views, so there is no way back to a list.
    const lead = isPhoneLayout() && src.lead ? src.lead() : null;
    const back = isPhoneLayout() && !lead ? `<button type="button" class="group-back group-table-back" data-on-click="sgroup-list" data-kind="${escapeAttr(open.kind)}">\u2190 ${escapeHtml(TAB_NAME[open.kind] || 'List')}</button>` : '';
    const bar = src.toolbar ? src.toolbar(open.key) : null;
    const html = (bar && !bar.node ? toolbarHtml(bar, tables[0]) : '') + tables.map((x, i) => tableHtml(x, i, i ? '' : back, !!bar)).join('');
    host.dataset.group = open.kind + ':' + open.key; // which table is on screen (saved.js asks for the Inbox's Saved)
    const a = document.activeElement, typing = a && host.contains(a) && a.id === 'gt-search' ? { start: a.selectionStart, end: a.selectionEnd } : null;
    // A component toolbar keeps its own listeners, open panel, search, and focus across table redraws.
    const toolbarFocus = bar?.node?.contains(a) ? a : null;
    const toolbarCaret = toolbarFocus && typeof toolbarFocus.selectionStart === 'number' ? [toolbarFocus.selectionStart, toolbarFocus.selectionEnd] : null;
    const folderPage = bar?.node && tables[0] && tables[0].noun ? tables[0] : null;
    const drawn = html + (src.signature?.() || '') + (folderPage ? `|head:${folderPage.title}:${folderPage.count === undefined ? folderPage.rows.length : folderPage.count}` : '') + (bar?.signature || '') + tables.map(x => (x.node ? `|${x.signature || ''}` : '')).join('') + (lead ? `|${lead.signature}` : ''); // a table with its own rows says what they are (signature): the same rows are not drawn again
    // A row the keyboard is on keeps it across a redraw (the Inbox's "waiting 4 min" moves on every 30 seconds while the table is the only list, #7004): it is found again by its class and data attributes
    const held = host.contains(a) && a.matches('.group-chip, .dt-primary, .dt-quiet') ? { cls: a.className, data: JSON.stringify(a.dataset) } : null;
    if (host.dataset.drawn !== drawn) {
        host.innerHTML = html; host.dataset.drawn = drawn; // a redraw of what is there would drop the focus from a row the keyboard is on
        if (bar?.node) host.prepend(bar.node);
        if (folderPage) folderHead(bar.node, folderPage);
        if (lead) host.prepend(lead.node());
        const slots = host.querySelectorAll('.group-table-node'); // one per table that draws its own rows (and has some), in order
        let k = 0;
        for (const x of tables) if (x.node && (x.rows.length || !x.empty)) slots[k++]?.replaceWith(x.node());
    }
    if (toolbarFocus && toolbarFocus.isConnected && document.activeElement !== toolbarFocus) {
        toolbarFocus.focus({ preventScroll: true });
        if (toolbarCaret) toolbarFocus.setSelectionRange(...toolbarCaret);
    }
    if (held && host.dataset.drawn === drawn && !host.contains(document.activeElement)) [...host.querySelectorAll('.group-chip, .dt-primary, .dt-quiet')].find(e => e.className === held.cls && JSON.stringify(e.dataset) === held.data)?.focus({ preventScroll: true });
    if (typing) { const again = document.getElementById('gt-search'); if (again && again !== a) { again.focus({ preventScroll: true }); try { again.setSelectionRange(typing.start, typing.end); } catch { /* a search field has a caret */ } } } // the person is typing in the page's search: the redraw keeps their caret
    return true;
}

/** Opens a group as a table in the centre. */
export function openGroupTable(kind, key, { focus = false } = {}) {
    open = { kind, key };
    if (!drawTable()) { open = null; return false; }
    showView('group-table-view');
    // a group opened by the person: the keyboard starts at the page's search box (the first control of the toolbar, #7404), else the first row, else the heading (a ring round the word was the arrival's look)
    if (focus) (document.querySelector('#group-table-view .gt-search, #group-table-view .list-bar-search') || document.querySelector('#group-table-view .dt-primary') || document.getElementById('group-table-title'))?.focus({ preventScroll: true });
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
    if (src && src.landing) return src.keys().length ? openGroupTable(kind, LANDING) : false;
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
    'sgroup-open': el => {
        const kind = textOf(el.dataset.kind), key = textOf(el.dataset.group); if (!kind || !key) return;
        const open = () => { if (!openGroupTable(kind, key, { focus: true })) sources.get(kind)?.showList?.(); };
        // A chat opened by a link or a reload says "<- folder" before the Inbox module that registers its source has loaded (#8817): the press waits for it, not for a second press.
        if (!sources.has(kind) && LAZY_SOURCES[kind]) importOnce(LAZY_SOURCES[kind]).then(open, () => {}); else open();
    }, // a group that has gone (a filter, a fold of the list) leaves for the tab's own page
    'sgroup-chevron': (el, event) => { event.stopPropagation(); const kind = textOf(el.dataset.kind), key = textOf(el.dataset.group); if (kind && key) toggleGroupFold(kind, key); },
    'sgroup-key': (el, event) => {
        if (event.target !== el || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        const kind = textOf(el.dataset.kind), key = textOf(el.dataset.group);
        if (kind && key) openGroupTable(kind, key, { focus: true });
    },
    // The page's search is the sidebar's: its text goes into the sidebar's field and that field's own handler runs (the list and the table follow).
    'sgroup-search': el => { const target = document.getElementById(textOf(el.dataset.search)); if (!target || target.value === el.value) return; target.value = el.value; target.dispatchEvent(new Event('input', { bubbles: true })); },
    'gt-menu-toggle': async el => { (await importOnce('./menu_button.js')).toggleMenu(el); },
    'sgroup-retry': el => { const t = drawnTables[Number(el.dataset.table)]; if (t && typeof t.retry === 'function') t.retry(); }, // a table's note that a computer did not answer has a Retry: the table says what it does
    'sgroup-list': el => { const kind = textOf(el.dataset.kind); open = null; sources.get(kind)?.showList?.(); },
});

// A choice in the page toolbar's More menu closes the menu (the action itself runs from its own attribute).
document.addEventListener('click', e => { if (e.target instanceof Element && e.target.closest('.gt-menu [role="menuitem"]')) importOnce('./menu_button.js').then(m => m.closeMenus(), () => {}); });
