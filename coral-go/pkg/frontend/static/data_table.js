/* The one table (#7743): every list or table surface passes what to show, the component owns how it looks and behaves. The operator's rule: a styling change is one token or one rule, so every size and colour here
 * is a --table-* token (css/data_table.css) and no surface styles a row, a cell or a header.
 *
 *   dataTable({ label, columns, rows, rowKey, keepOrder, orderKey, groupBy(row) -> { key, label }, open, current, state, onSort, layout, fold, foldAt, sortBar, defaultSortLabel, bare, empty, footer, selectable, rowName, quiet, scroll, detail, decorate, decorateHead }) -> { el, bar, selectButton, selection(), clear(), state }
 *   selectable = { contextKey, onChange(keys), longPress (a touch screen selects a row by pressing and holding it), clearLabel (the bar's last button, 'Clear'), iconBar (one line: Cancel as an X, the count, actions with icon() as icon buttons, and those with more: true in a three-dot menu), actions (an action may have askWhen(n) and confirm(n): it asks first only when askWhen says so): [{ label, run(rows, keys, value), danger, confirm, choose: { label, options() -> [{ value, label }] } }] }: a danger action confirms in the bar, a choose action asks for its value there.
 *   Column = { key, label, field | cell(row, ctx), primary, tone: 'primary'|'secondary'|'tertiary', width: 'grow'|'content'|'<n>rem', fixed (with a rem width: that width, no resize handle, never squeezed or kept: a list's Actions, #9845), nowrap, align: 'start'|'end', numeric,
 *              sort: true|'number'|'date'|fn(a, b), sortValue(row), firstDir: 'asc'|'desc', foldFirst, narrowHide, line: 0|1|2, foldLabel, when(row), subtitle(row), subtitleTitle(row), title(row), filter: { label, active(), open(button) }, hideLabel }
 *   column widths (#7949): every header has a resize handle on its right edge (drag, Left and Right keys, double-click or Enter to fit the content); the widths are kept per list in this browser (widthsKey, else the label without its row count), and there is no reset button: a double click on a column edge fits it to its content (#9845). minWidth per column (64 px by default), resize: false for one that must not.
 *   detail = { id(row), open(row) -> bool, render(row) -> Node }: a second full-width row under each row (hidden while open(row) is false); the surface's own toggle in a cell opens it (Coral Hub's Servers: health, what applies).
 *   decorate(row, tr, detailTr) and decorateHead(th, column): called each time the rows (or the header) are drawn, for the hooks a surface keeps on them.
 *   cell types: chip(word, cls), avatar(name), avatars(people, label), personButton(name, label), tag(text), timeCell(stamp), link(text, run), primaryButton(text, label)
 *   oneLine: true: keep one row, hide columns with dropAt 62/52/36/28/16 (rem) as the container narrows; never fold. resize: true opts into shared desktop resizing and remembered widths.
 *   wrapNames: true (with oneLine): in a narrow table the name wraps at its words, to two or three lines, rather than ending in an ellipsis mid-word (the Automations lists).
 *   compact: true: a folded column row is two compact lines (60 px; the name on one line): the Tasks lists and the dock's Artifacts ask for it (#8496); other folded tables keep two-line names and descriptions.
 *   state: tableState(), kept by the caller across redraws: the sort, and the selection (a set of row keys, kept while the rows are filtered or paged, cleared when selectable.contextKey changes).
 * Folded (the table's own box narrower than foldAt rem, 40 by default; 'fit' measures the unfolded columns; also at 200% text): fold 'column' is the two-line row (line 1 and line 2 cells), fold 'labeled' is the name, then "label value" lines
 * (the Analytics tables); scroll: a table of many columns scrolls sideways inside its box, shaded where more is to come, rather than being cut off; the header row is hidden and a "Sort by" select takes its place. Everything is built with the DOM and textContent: titles and names are written by agents. */
import { isPhoneLayout } from './phone_layout.js';
import { importOnce } from './import_once.js';
import { markAgent } from './agent_live.js';
import { whenText, shortWhen } from './when_text.js';
import { browserLocal } from './safe_storage.js';
import { loadStyles } from './lazy_styles.js';

export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const button = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

/** A select box with its 44 px target (#9576): the box is 16 px, so a label around it is what a finger hits (a touch screen's census counts a checkbox as its label); the label's own click is the box's and goes no further (the row's handler would open the row). */
const checkHit = input => { const l = el('label', 'dt-check-hit'); l.append(input); l.addEventListener('click', e => e.stopPropagation()); return l; };

export const tableState = () => ({ widths: null, sort: null, selected: new Set(), rowCache: new Map(), anchor: null, ctx: undefined, select: false, confirming: -1 });

// ── cell types ────────────────────────────────────────────────────────────
/** A title (the hover tooltip) set on pointer enter, and only while `needed()` says the text it carries is cut or hidden. */
export const tipIf = (e, text, needed) => e.addEventListener('pointerenter', () => { if (!e.title || e.title === text) e.title = needed() ? text : ''; }); // a title a caller set with better words is left alone
/** The row's one real button: its text names the row. */
export function primaryButton(text, label) {
    const b = el('button', 'dt-primary', text); b.type = 'button';
    tipIf(b, text, () => b.scrollWidth > b.clientWidth); // a name the row cuts with an ellipsis is read whole on hover (#8206), and only then: a title on a name that fits is a tooltip left behind on scroll (#11566); a caller with better words sets its own
    if (label) b.setAttribute('aria-label', label);
    return b;
}
/** A state as a dot and a word (the dot is decoration: the word says it). */
/** A state as a coloured dot and its word in the same colour: no outline and no fill (the operator, #11356). The one builder for every state in every list (the task, job, goal, run and agent tables, the team pages and the goal's page); on a phone the word is hidden and the dot stands for it (css/goals.css). */
export function chip(word, cls) {
    const c = el('span', `state-label dt-chip goal-chip ${cls || ''}`.trim());
    const dot = el('span', 'goal-dot'); dot.setAttribute('aria-hidden', 'true');
    c.append(dot, el('span', 'state-word', word));
    tipIf(c, word, () => c.lastChild.offsetWidth <= 1); // a tooltip only while the word is hidden (a phone's dot): a title that repeats a shown word is left behind on scroll (#11561)
    return c;
}
export function tag(text) { return el('span', 'chip chip-tag dt-tag', text); }
// white 11/700 on each of these is 4.5:1 or more
// the eight colours are --avatar-1 .. --avatar-8 (variables.css): white 11/700 on each is 4.5:1 or more
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h; };
/** A person: a 20 px circle with the first letter, one fixed colour per name, then the name. */
export function avatar(name, text) {
    const w = el('span', 'dt-person');
    const n = String(name || '').trim();
    if (!n) { w.textContent = text || ''; return w; }
    const a = el('span', 'dt-avatar', [...n][0].toUpperCase()); a.setAttribute('aria-hidden', 'true'); a.style.background = `var(--avatar-${(hash(n.toLowerCase()) % 8) + 1})`;
    const nm = el('span', 'dt-person-name', text || n); w.append(a, nm); // text: what is said beside the circle when it is more than the name ("Done by Dev")
    if (markAgent(a, n)) markAgent(nm, n); // a running agent's circle and name open its chat (#12197)
    return w;
}
/** People as a row of circles and nothing else (the Tasks table's Assigned to, #8492): the person responsible first, one solid circle; then reviewers as smaller outlined circles, at most two, then "+N". The whole cell is one image named by label
 *  ("Done by Dev, reviewed by QA"), which is also its hover text, so the column is as narrow as its circles. people = [{ name, review? }]. */
export function avatars(people, label) {
    const w = el('span', 'dt-person dt-avatars'); w.setAttribute('role', 'img'); w.setAttribute('aria-label', label); w.title = label;
    const circle = (name, cls) => { const n = String(name || '').trim(); const a = el('span', `dt-avatar${cls}`, [...n][0].toUpperCase()); a.setAttribute('aria-hidden', 'true'); markAgent(a, n); a.style.setProperty('--dt-avatar-bg', `var(--avatar-${(hash(n.toLowerCase()) % 8) + 1})`); return a; };
    const named = people.filter(p => p && String(p.name || '').trim());
    for (const p of named.filter(x => !x.review)) w.append(circle(p.name, ''));
    const reviewers = named.filter(x => x.review);
    for (const p of reviewers.slice(0, 2)) w.append(circle(p.name, ' dt-avatar-review'));
    if (reviewers.length > 2) w.append(el('span', 'dt-avatars-more', `+${reviewers.length - 2}`));
    return w;
}
/** A person who is also the row's button: the circle, then the name as the one real button (Needs you: the agent). */
export function personButton(name, label) {
    const w = avatar(name);
    const b = primaryButton(name, label);
    w.querySelector('.dt-person-name')?.replaceWith(b);
    if (!w.querySelector('.dt-avatar')) w.append(b);
    return w;
}
/** A time as the app says it (relative), with the exact time on hover. */
export function timeCell(stamp) {
    const s = el('span', 'dt-time', whenText(stamp));
    if (stamp) s.title = new Date(stamp).toLocaleString();
    return s;
}
/** The short time of a phone's mail row ("5m", "2:32 PM", "Yesterday", "Mon", "Oct 17"). */
export const shortTime = stamp => shortWhen(stamp);
export function link(text, run) { return button('dt-link', text, run); }

/** Task completion: visible counts remain meaningful without colour or a filled bar. */
export function progressCell(done, total) {
    const cell = el('span', 'dt-progress');
    if (!total) { cell.textContent = 'No tasks yet'; return cell; }
    const label = `${done} of ${total} done`;
    const meter = el('progress', 'dt-progress-meter');
    meter.max = total; meter.value = done; meter.setAttribute('aria-label', label);
    cell.append(el('span', 'dt-progress-text', label), meter);
    return cell;
}

// ── the table ─────────────────────────────────────────────────────────────
const INTERACTIVE = 'a, input, select, textarea, summary, button:not(.dt-primary)';
export const compareBy = (col) => { // exported for its unit test (data_table_compare.test.mjs)
    if (typeof col.sort === 'function') return col.sort;
    const val = col.sortValue || ((r) => (col.field != null ? r[col.field] : ''));
    return (a, b) => {
        const x = val(a), y = val(b);
        if (col.sort === 'number' || col.sort === 'date' || (typeof x === 'number' && typeof y === 'number')) { const at = v => (col.sort === 'date' ? (typeof v === 'number' ? v : Date.parse(v) || 0) : Number(v) || 0); /* a 'date' value is a time in ms or a string Date.parse reads: Date.parse of a number is NaN, which tied every row (#9680) */ return at(x) - at(y); }
        return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true, sensitivity: 'base' });
    };
};

/** The phone's mail row (#9545, UI/UX's spec): a 44 px leading target holding a 32 px avatar, the title and the first words of what it says on one line, the time at the right, and under the line (Needs you only) the ask.
 *  A caller opts in with `mail(row) -> { actions?: [{ label, title?, off?, confirm?, onArm?, run(button) }] (a ⋯ button at the row's right opens them, #137104), lead: { text, name?, square?, icon? }, kindIcon? (a node drawn before the title), title, snippet?, state?, ask?, askTag?, time?, unread?, mark?, data?, tip?, team?, teamAlways?, nameTeam?, snippetTip? }` (nameTeam: the team is in the button's name but not drawn on the line, so Needs you is one line, #9986) (state: the word the row shows for what it is in (a task's Queued, In review), said in the button's name after the title, so a screen reader hears <name>, <state> (#9747)) (team: after the title in tertiary, always when teamAlways, else only for a title two rows share) (data: attributes for the open button, as `{ taskId: 5 }` is data-task-id="5"); on a phone the row is this cell alone (the columns are the desktop's), and its button is the row's open control.
 *  `unread` makes the title 600 (a read one is 500) and draws an accent dot under the time that is named "Unread" for a screen reader: a list says it only where a read state exists (Needs you; chats, boards and tasks through inbox_read.js, #9687). `mark: 'attention'` is the amber dot under the time and outranks the unread dot (one dot a row). A desktop table takes `unread(row)` for the same look as a `dt-unread` row. Text is set with textContent only. */
const MAIL_QUERY = '(max-width: 767px)';
let rowMenus = 0;
/** A phone mail row's ⋯ (#137104): a 44 px button at the row's right that opens the one menu (menu_button.js: arrow keys, Escape back to the button, Tab or a tap elsewhere closes) of the row's actions. `actions`: [{ label, title, run(button) }].
 *  The button is the row's own control, a sibling of the row's button (a button holds no button); a press on it never opens or selects the row. */
function rowMore(actions, label) {
    const id = `dt-mail-more-${++rowMenus}`, wrap = el('span', 'dt-mail-more');
    const toggle = el('button', 'btn btn-quiet btn-icon dt-mail-more-toggle'); toggle.type = 'button'; toggle.id = id;
    toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', `${id}-menu`); toggle.setAttribute('aria-label', `More actions for ${label}`);
    toggle.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>'; // the phone agent bar's ⋯ (#11056)
    const menu = el('div', 'menu dt-mail-menu'); menu.id = `${id}-menu`; menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `Actions for ${label}`);
    for (const a of actions) {
        const b = el('button', 'menu-item', a.label); b.type = 'button'; b.setAttribute('role', 'menuitem'); if (a.title) b.title = a.title;
        if (a.off) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); } // an action that is off right now stays in the menu, said off (the first in a line cannot move up)
        b.addEventListener('click', async e => {
            e.stopPropagation();
            if (a.confirm && !b.dataset.armed) { // an action that asks once more (Kick): the first press says so in the item's words and keeps the menu open, the second does it
                b.dataset.armed = '1'; b.textContent = a.confirm; if (a.onArm) a.onArm(b);
                setTimeout(() => { delete b.dataset.armed; b.textContent = a.label; }, 10000);
                return;
            }
            (await importOnce('./menu_button.js')).closeMenus({ restoreFocus: true }); a.run(b);
        });
        menu.append(b);
    }
    toggle.addEventListener('click', async e => { e.stopPropagation(); (await importOnce('./menu_button.js')).toggleMenu(toggle); });
    wrap.append(toggle, menu);
    return wrap;
}
const mailCell = (m, label, open, pick, showTeam = false, gap = false) => { // open: the row opens (a button), pick: a function that selects it, or null, showTeam: the team is drawn after the title (always for Needs you, and for a title two rows share)
    const td = el('td', 'dt-mail-cell'); td.setAttribute('role', 'cell');
    const lead = el(pick ? 'button' : 'span', 'dt-mail-lead');
    if (pick) { lead.type = 'button'; lead.setAttribute('role', 'checkbox'); lead.setAttribute('aria-label', `Select ${label}`); lead.setAttribute('aria-checked', 'false'); lead.addEventListener('click', pick); } else lead.setAttribute('aria-hidden', 'true'); // a list that can be selected: the avatar is its checkbox (a tap, no gesture), as the desktop's is
    const l = m.lead || {}, shape = l.icon ? el('span', 'dt-mail-avatar material-icons', l.icon) : el('span', 'dt-mail-avatar', [...String(l.text || m.title || '?')][0].toUpperCase());
    if (l.square) shape.classList.add('dt-mail-square');
    shape.style.background = `var(--avatar-${(hash(String(l.name || m.title || '').toLowerCase()) % 8) + 1})`;
    const tick = el('span', 'dt-mail-avatar dt-mail-tick material-icons', 'check'); tick.setAttribute('aria-hidden', 'true'); // the avatar of a selected row
    lead.append(shape, tick);
    const body = el(open ? 'button' : 'span', `dt-mail-open${m.unread ? ' dt-mail-unread' : ''}${open ? ' dt-primary' : ''}`);
    if (m.tip) body.title = m.tip; // the whole words behind the line's cut or dropped parts (a row's team and computer): its hover
    if (m.data) Object.assign(body.dataset, m.data); // the data-* the row's primary button carried as a column (a task's data-task-id): what finds the row again and what a deep link or a focus return reads
    if (open) { body.type = 'button'; body.dataset.rowName = label; { const kind = m.kindIcon && m.kindIcon.getAttribute('aria-label'); const named = ((showTeam || m.nameTeam) && m.team ? `${label}, ${m.team}` : label) + (kind ? `, ${kind}` : '') + (m.state ? `, ${m.state}` : '') + (m.starred && !/, starred$/.test(String(label)) ? ', starred' : '') + (m.live ? `, ${m.live.toLowerCase()}` : ''); body.setAttribute('aria-label', (m.unread && !m.mark ? `${named}, unread` : named) + (m.time && !String(named).includes(m.time) ? `, ${m.time}` : '')); } } // the name holds every word the row shows (the time too), so a visible label is in its name; its click is the row's (a .dt-primary button is not interactive to the row's handler: it opens, or toggles while selecting)
    const text = el('span', 'dt-mail-text'), line = el('span', 'dt-mail-line');
    const titleEl = el('span', `dt-mail-title${m.medium ? ' dt-mail-medium' : ''}`, m.title || ''); if (m.kindIcon) titleEl.prepend(m.kindIcon); // a Needs you row's kind icon (#13144) leads the title inside it, so the line's rules (the cut, the team's wrap, the narrow column) act on one element and the icon never lands on a line of its own; it has no text
    line.append(titleEl); // medium: the title is a name (an agent), so 13/500, not a row's own title at 400 (#9758)
    if (m.starred) { const star = el('span', 'dt-star dt-star-on dt-mail-star material-icons', 'star'); star.setAttribute('aria-hidden', 'true'); line.append(star); } // a starred artifact keeps its glyph on a phone, which is a mark, not a button (#9834)
    if (showTeam && m.team) line.append(el('span', 'dt-mail-team', ` - ${m.team}`)); // who is asking: the team (with its computer when a hub has several) after the title in the tertiary colour
    { const sn = el('span', 'dt-mail-snippet', m.snippet || ''); if (m.snippetTip && m.snippet) sn.title = m.snippetTitle || m.snippet; line.append(' ', sn); } // snippetTip: the whole words are the snippet's hover (snippetTitle: longer words than the line shows, #11442) where the line cuts it (Needs you's ask, #9495, #9986) // a space between the words: the row reads as words, not run together
    if (m.live) { const dot = el('span', 'dt-mail-live'); dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', m.live); dot.title = m.live; line.append(dot); } // a live chat's state: a dot after the title (names stay in one column), its word the label (Active now) (#9740)
    text.append(line);
    if (m.ask) { text.classList.add('dt-mail-two'); const ask = el('span', 'dt-mail-ask'); if (m.askTag) ask.append(tag(m.ask)); else ask.textContent = m.ask; tipIf(ask, m.ask, () => ask.scrollHeight > ask.clientHeight || ask.scrollWidth > ask.clientWidth); text.append(ask); } // the whole ask is the line's title, so a cut one can be read (#9495)
    const side = el('span', 'dt-mail-side'); side.append(el('span', 'dt-mail-time', m.time || ''));
    if (m.mark) { const dot = el('span', `dt-mail-dot dt-mail-${m.mark}`); dot.setAttribute('aria-hidden', 'true'); side.append(dot); }
    else if (m.unread) { const dot = el('span', 'dt-mail-dot dt-mail-new'); dot.append(el('span', 'sr-only', 'Unread')); side.append(dot); } // the dot is the signal, the 600 only reinforces it, and neither is colour alone
    body.append(text, ' ', side);
    td.append(lead, body);
    if (m.actions && m.actions.length) td.append(rowMore(m.actions, label)); // a row's ⋯ menu, after the row's button and before its choices
    else if (gap) { const g = el('span', 'dt-mail-more-gap'); g.setAttribute('aria-hidden', 'true'); td.append(g); }
    if (m.answers) td.append(m.answers); // a Needs you row's choices, under the line (#10400)
    return td;
};

export function dataTable(cfg) {
    if (cfg.oneLine) cfg = { ...cfg, fold: 'none', layout: 'fixed', resize: cfg.resize === true };
    const st = cfg.state || tableState();
    const columns = cfg.columns, sel = cfg.selectable || null, ctx = cfg.ctx || {};
    const foldKind = cfg.oneLine ? 'none' : cfg.fold || 'column', foldAt = cfg.foldAt || 40;
    if (sel && sel.contextKey !== undefined && st.ctx !== String(sel.contextKey)) { st.selected.clear(); st.rowCache?.clear(); st.confirming = -1; st.choices = null; st.anchor = null; st.ctx = String(sel.contextKey); }
    const hasContent = cfg.columns.some(c => c.width === 'content');
    const box = el('div', `dt-box${cfg.compact ? ' dt-compact' : ''}${foldAt === 'fit' ? ' dt-fit' : ''}${hasContent ? ' dt-has-content' : ''}${cfg.bare ? ' dt-bare' : ''}${cfg.scroll ? ' dt-scroll' : ''} ${foldKind === 'labeled' ? 'dt-fold-labeled' : foldKind === 'always' ? 'dt-fold-column' : foldKind === 'none' ? 'dt-fold-none' : 'dt-fold-column'}`);
    if (cfg.oneLine) box.classList.add('dt-one-line');
    if (cfg.oneLine && cfg.wrapNames) box.classList.add('dt-wrap-names'); // a narrow list wraps a long name at its words (hyphens too) instead of cutting it mid-word with an ellipsis (#10275)
    const mailQuery = cfg.mail && typeof window.matchMedia === 'function' ? window.matchMedia(MAIL_QUERY) : null, mailOn = () => !!mailQuery && mailQuery.matches; // a phone's rows are mail rows
    box.classList.toggle('dt-mail-on', mailOn());
    const bar = el('div', 'dt-bar'); bar.hidden = true;
    const live = el('span', 'sr-only'); live.setAttribute('role', 'status'); // the selection bar comes and goes: a screen reader hears "3 selected" from a region that stays in the page
    box.append(live);
    const selectButton = button('btn btn-small dt-select-toggle', 'Select', () => { st.select = !st.select; syncSelectMode(); });
    selectButton.setAttribute('aria-pressed', 'false'); selectButton.hidden = !sel;
    let rows = cfg.rows.slice();
    const keyOf = (r) => String(cfg.rowKey(r));
    const eligible = r => !sel?.canSelect || sel.canSelect(r);
    st.rowCache ||= new Map();
    for (const r of rows) { if (eligible(r)) st.rowCache.set(keyOf(r), r); else { st.selected.delete(keyOf(r)); st.rowCache.delete(keyOf(r)); } }
    const nameOf = (r) => (cfg.rowName ? cfg.rowName(r) : keyOf(r));

    const sortBar = el('div', 'dt-sortbar');
    if (cfg.sortBar === false) sortBar.hidden = true; // a narrow column of a few rows (a goal's tasks) needs no Sort by
    const table = el('table', 'dt-table'); table.setAttribute('aria-label', cfg.label); table.setAttribute('role', 'table');
    if (cfg.layout === 'fixed' || cfg.oneLine) table.style.tableLayout = 'fixed'; // grouped lists share column widths even when their contents differ
    const thead = el('thead'); thead.setAttribute('role', 'rowgroup'); const tbody = el('tbody'); tbody.setAttribute('role', 'rowgroup');
    const colgroup = el('colgroup');
    table.append(colgroup, thead, tbody);
    // the columns left out to fit the panel are never silently gone (#11943): a quiet control says how many, lists them and brings one back (it then keeps its place and the others give way by the same rules)
    let hiddenSeq = 0;
    const hiddenBar = el('div', 'cols-hidden-bar'); hiddenBar.hidden = true;
    const hiddenId = `dt-cols-hidden-${++hiddenSeq}`; // a counter, not a random suffix: the markup is the same on every draw (task_list_golden)
    const hiddenMenu = el('div', 'menu cols-hidden-menu'); hiddenMenu.id = `${hiddenId}-menu`; hiddenMenu.hidden = true; hiddenMenu.setAttribute('role', 'menu'); hiddenMenu.setAttribute('aria-label', 'Hidden columns');
    const hiddenBtn = button('btn btn-quiet btn-small cols-hidden-btn', '', async (e) => { e.stopPropagation(); (await importOnce('./menu_button.js')).toggleMenu(hiddenBtn); });
    hiddenBtn.id = hiddenId; hiddenBtn.setAttribute('aria-haspopup', 'menu'); hiddenBtn.setAttribute('aria-expanded', 'false'); hiddenBtn.setAttribute('aria-controls', hiddenMenu.id);
    const resetBtn = button('btn btn-quiet btn-small cols-reset-btn', 'Reset column widths', () => resetWidths()); resetBtn.hidden = true; resetBtn.title = 'Give every column the width it has when nobody has dragged one'; // widths kept by a drag can be taken back (#12409)
    hiddenBar.append(resetBtn, hiddenBtn, hiddenMenu);
    const closeHidden = () => { if (!hiddenMenu.hidden) importOnce('./menu_button.js').then(m => m.closeMenus()).catch(() => {}); };
    box.append(sortBar, hiddenBar, table);

    // ── column widths (#7949): a handle on each header's right edge; the widths are kept per list in this browser ──
    const MIN_W = 64, MAX_W = 2000, STEP = 16;
    const wkey = `coral-dt-widths:${cfg.widthsKey || String(cfg.label).replace(/,\s*\d.*$/, '')}`; // a label that counts its rows ("Tasks, 12") is the list "Tasks"
    const headNeed = (c) => { const th = thead.querySelector(`th.dt-th[data-key="${c.key}"]`), t = th && th.querySelector('.dt-sort > span, .dt-head-text'); if (!t || !th.getClientRects().length) return 0; const cs = getComputedStyle(th); return Math.ceil(t.getBoundingClientRect().width + (c.sort ? 20 : 0) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)); }; // the width its whole head needs: the label, the sort arrow and the cell's padding (#11835: Blocks was cut to "Bl")
    const minOf = (c) => Math.max(c.minWidth || MIN_W, headNeed(c));
    const wOf = (c) => (st.widths[c.key] ? Math.max(st.widths[c.key], minOf(c)) : 0);
    const ITEM_MIN = 120; // the name column is the one that gives room: it truncates down to this
    const fixedW = (c) => (c.fixed && /rem$/.test(c.width || '') ? c.width : null); // a fixed column (the Actions of a list) has the width it declares: no handle, never frozen or kept, so no other column's resize squeezes its buttons (#9845)
    const elasticColumn = cols => cols.find(c => c.width === 'grow') || cols.find(c => c.primary) || cols.find(c => !fixedW(c) && !c.fixed);
    function readWidths() {
        try {
            const o = JSON.parse(browserLocal.get(wkey) || 'null') || {}, out = {};
            for (const c of columns) { const v = Number(o[c.key]); if (!c.fixed && c !== elasticColumn(columns) && Number.isFinite(v) && v >= minOf(c) && v <= MAX_W) out[c.key] = Math.round(v); } // a fixed column is never kept
            return out;
        } catch { return {}; }
    }
    function saveWidths() {
        if (Object.keys(st.widths).length) browserLocal.set(wkey, JSON.stringify(st.widths)); else browserLocal.remove(wkey); // a convenience: the store is guarded, and the widths last until the page closes without it
    }
    let emptyKeys = new Set(); // the columns no row has anything in (syncEmptyColumns, below)
    let tightKeys = new Set(); // the columns dropped because the box is narrow (applyWidths, below): their <col> is hidden too, or the widths of the colgroup shift onto the wrong columns (#10443)
    st.widths ||= cfg.oneLine && !cfg.resize ? {} : readWidths();
    const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    /** What the last resizable column takes: its own width, or what the others leave of the box. */
    function fillPx(c, shown) {
        const t = thead.querySelector('th.dt-check'), rest = (sel && t ? Math.round(t.getBoundingClientRect().width) : 0) + shown.filter(x => x !== c).reduce((n, x) => n + (wOf(x) || (fixedW(x) ? parseFloat(fixedW(x)) * remPx() : 0)), 0);
        return Math.max(wOf(c), Math.floor(box.clientWidth - rest));
    }
    /** Every column's width is decided here, in one place (#11943, the operator's table rules, design note 9ced561a): the table always fits its box; ONE column (the primary, or the one that grows) is elastic and takes what the others leave; a column is never narrower than its whole header; a kept width is fitted to the box it meets; Time and Actions (fixed, in rem) keep their width. The columns have the width their content needs (at most their own max), a kept width wins; when they do not fit, the optional ones go by priority (`drop`, lowest first), then the others are squeezed, last first, down to their header, and only then does the table scroll. A phone's folded rows are laid out by CSS: nothing here. */
    function syncHidden(dropped) {
        const gone = columns.filter(c => dropped.has(c.key));
        const kept = Object.keys(st.widths).length > 0;
        resetBtn.hidden = !kept; hiddenBtn.hidden = !gone.length; hiddenBar.hidden = !gone.length && !kept;
        if (!hiddenBar.hidden) loadStyles('data_table_hidden.css'); // the bar's rules come the first time a column is hidden or a width is kept, not at start
        if (!gone.length) { closeHidden(); return; }
        const word = `${gone.length} column${gone.length === 1 ? '' : 's'} hidden`; hiddenBtn.textContent = word; hiddenBtn.setAttribute('aria-label', `${word}: ${gone.map(c => c.label || c.key).join(', ')}. Show one`);
        hiddenMenu.replaceChildren(...gone.map(c => { const b = button('menu-item', `Show ${c.label || c.key}`, async e => { e.stopPropagation(); (st.pinned ||= new Set()).add(c.key); (await importOnce('./menu_button.js')).closeMenus({ restoreFocus: true }); applyWidths(); }); b.setAttribute('role', 'menuitem'); return b; }));
    }
    let L0 = null; // the last layout: the box's width, what each column got and the room the elastic column has left (setWidth reads it)
    function measureNatural(live) { // the table is laid out at its natural width for a moment (auto layout, as wide as its content, none of the sizes below): each head is as wide as its widest cell, its own max or its head needs
        for (const n of box.querySelectorAll('.dt-col-tight')) n.classList.remove('dt-col-tight'); // every column is shown while it is measured: a hidden column measures 0 and the next layout would not drop it, then would (it flip-flopped)
        colgroup.replaceChildren(); table.style.tableLayout = 'auto'; table.style.width = 'max-content'; box.classList.remove('dt-sized'); box.style.removeProperty('--dt-sized-min'); box.classList.add('dt-measure'); // (the sizes of a laid-out table, --dt-sized-min among them, are off while it is measured, so the natural width is the same every time)
        const out = {};
        for (const c of live) { const th = thead.querySelector(`th.dt-th[data-key="${attrEsc(c.key)}"]`); out[c.key] = th && th.getClientRects().length ? Math.ceil(th.getBoundingClientRect().width) : 0; }
        box.classList.remove('dt-measure');
        return out;
    }
    const cssHides = (c) => (!!c.narrowHide && box.clientWidth <= 64 * remPx()) || (cfg.oneLine && c.dropAt && box.clientWidth <= c.dropAt * remPx()); // data_table.css hides a narrowHide column in a box of 64 rem or less: it has no cell then, so it takes no width (its <col> would shift every width after it onto the wrong column)
    function applyWidths() {
        if ((cfg.oneLine || cfg.layout === 'fixed') && cfg.resize !== true) return;
        // A folded (phone) row is laid out by CSS: what the unfolded table left on it goes, or the folded rows keep its pixel width (#11943). A box that is not shown (its dock shut, or a layout that hides it) has no room to size
        // for: the pixel widths of its last layout go too, or a dock opened at a narrower width shows a table as wide as it was before until the next frame (a task row 30 px past the box at 390, #12368).
        if (mailOn() || box.classList.contains('dt-folded') || (cfg.oneLine && isPhoneLayout()) || !box.clientWidth) {
            if (L0) { L0 = null; colgroup.replaceChildren(); table.style.tableLayout = ''; table.style.width = ''; box.classList.remove('dt-sized'); box.style.removeProperty('--dt-sized-min'); tightKeys = new Set(); for (const n of box.querySelectorAll('.dt-col-tight')) n.classList.remove('dt-col-tight'); syncHidden(new Set()); }
            return;
        }
        if (!box.clientWidth) return;
        const avail = box.clientWidth, rem = remPx(), live = columns.filter(c => !emptyKeys.has(c.key) && !cssHides(c)), prim = elasticColumn(live); // a table always has one elastic column: the one it declares, or else its first that is not fixed
        for (const n of box.querySelectorAll('.dt-grow-implied')) n.classList.remove('dt-grow', 'dt-grow-implied'); // the elastic column a table did not declare is marked like one it did (dt-grow), until the layout picks it again
        if (prim && prim.width !== 'grow' && !prim.primary) for (const n of box.querySelectorAll(`th.dt-th[data-key="${attrEsc(prim.key)}"], td.dt-td[data-key="${attrEsc(prim.key)}"]`)) if (!n.classList.contains('dt-grow')) n.classList.add('dt-grow', 'dt-grow-implied');
        const nat = measureNatural(live);
        const chkTh = sel ? thead.querySelector('th.dt-check') : null, chk = chkTh && chkTh.getClientRects().length ? Math.round(chkTh.getBoundingClientRect().width) : 0;
        // the flexible columns: the elastic one (the primary, or the one that grows) and the others that declare a share; they split what the fixed-size columns leave, by their shares, none below its floor
        const flex = live.filter(c => c === prim || c.share), isFlex = c => flex.includes(c), w = {};
        const probe = el('span'); probe.style.cssText = 'position:absolute;visibility:hidden;width:100ch'; box.append(probe); const chPx = probe.getBoundingClientRect().width / 100; probe.remove(); // one character's width here
        const charsOf = c => (c.min ? Math.min(Math.round(c.min * chPx), Math.round(avail * 0.4)) : 0); // the room a column declares in characters (never more than 40% of the box)
        const hardOf = c => Math.max(ITEM_MIN, minOf(c)), pref = {}, base = {};
        const baseOf = c => (c === prim ? Math.max(hardOf(c), charsOf(c)) : Math.max(minOf(c), 96, charsOf(c))); // what a flexible column keeps at least (the name: 120 px, or its characters): no kept width in it, so what drops does not depend on a drag
        const natW = c => (fixedW(c) || (cfg.oneLine && /rem$/.test(c.width || '')) ? Math.round(parseFloat(c.width) * rem) : Math.min(MAX_W, Math.max(minOf(c), nat[c.key] || 0)));
        for (const c of live) { if (!isFlex(c)) w[c.key] = natW(c); }
        let active = live.slice(); const dropped = new Set();
        for (const c of flex) { base[c.key] = baseOf(c); if (c === prim) pref[c.key] = base[c.key]; }
        const total = () => chk + active.reduce((n, c) => n + (isFlex(c) ? base[c.key] : w[c.key]), 0);
        const squeezeOthers = () => { let over = total() - avail; for (const c of [...active].reverse()) { if (over <= 0) break; if (isFlex(c) || fixedW(c)) continue; const give = Math.min(over, w[c.key] - minOf(c)); if (give > 0) { w[c.key] -= give; over -= give; } } }; // the others give room, down to their whole header
        const squeezeFlex = () => { let over = total() - avail; for (const c of flex) { if (over <= 0) break; const give = Math.min(over, base[c.key] - (c === prim ? hardOf(c) : minOf(c))); if (give > 0) { base[c.key] -= give; over -= give; } } }; // and the flexible ones, down to their own floor
        while (total() > avail) { const next = active.filter(c => c !== prim && c.drop && !st.pinned?.has(c.key)).sort((x, y) => x.drop - y.drop)[0]; if (!next) break; active = active.filter(c => c !== next); dropped.add(next.key); } // the optional columns go, the lowest priority first
        squeezeOthers(); squeezeFlex();
        for (let guard = 0; !cfg.keepColumns && total() > avail && guard < 24; guard++) { const next = [...active].reverse().find(c => c !== prim && !isFlex(c) && !fixedW(c) && !st.pinned?.has(c.key)); if (!next) break; active = active.filter(c => c !== next); dropped.add(next.key); } // a table with no priorities of its own and still too wide at its header widths: the last columns go, rightmost first, before anything scrolls (#11943); a table whose columns are all data (cfg.keepColumns: a CSV) keeps every column and scrolls in its box (csv_viewer, the v2.0.35 gate)
        // what the person widened (a drag, a key, a width kept from an earlier visit) is applied to the columns that stayed: the elastic column pays first, then the others; nothing more is dropped because of it
        for (const c of active) { const k = st.widths[c.key]; if (!k) continue; if (!isFlex(c)) { if (!fixedW(c)) w[c.key] = Math.min(MAX_W, Math.max(minOf(c), k)); } else if (c !== prim) base[c.key] = Math.max(base[c.key], k); }
        if (prim && st.widths[prim.key]) base[prim.key] = Math.max(base[prim.key], Math.min(st.widths[prim.key], MAX_W));
        { let over = total() - avail; if (prim && over > 0) { const give = Math.min(over, base[prim.key] - hardOf(prim)); if (give > 0) { base[prim.key] -= give; over -= give; } } }
        squeezeOthers(); squeezeFlex();
        const others = active.reduce((n, c) => n + (isFlex(c) ? 0 : w[c.key]), chk);
        if (prim) base[prim.key] = Math.max(hardOf(prim), Math.min(pref[prim.key], avail - others - flex.filter(c => c !== prim && active.includes(c)).reduce((n, c) => n + base[c.key], 0)));
        const set = new Set(flex.filter(c => active.includes(c))); let free = avail - others;
        for (let pass = 0; pass < 8 && set.size; pass++) { // by shares: a column whose part is below its floor keeps the floor
            const sum = [...set].reduce((n, c) => n + (c.share || 1), 0); let moved = false;
            for (const c of [...set]) { const part = free * (c.share || 1) / sum; if (part < base[c.key]) { w[c.key] = base[c.key]; free -= w[c.key]; set.delete(c); moved = true; } }
            if (!moved) break;
        }
        { const sum = [...set].reduce((n, c) => n + (c.share || 1), 0); for (const c of set) w[c.key] = Math.max(base[c.key], Math.round(free * (c.share || 1) / sum)); }
        const floor = prim ? base[prim.key] : 0;
        tightKeys = dropped;
        syncHidden(dropped);
        for (const c of columns) for (const n of box.querySelectorAll(`th.dt-th[data-key="${attrEsc(c.key)}"], td.dt-td[data-key="${attrEsc(c.key)}"]`)) n.classList.toggle('dt-col-tight', dropped.has(c.key));
        colgroup.replaceChildren();
        if (sel) { const k = el('col'); k.style.width = chkTh ? `${chk}px` : 'var(--table-check-w)'; colgroup.append(k); }
        for (const c of columns) { const k = el('col'); if (emptyKeys.has(c.key) || cssHides(c)) k.classList.add('dt-col-unused'); else if (dropped.has(c.key)) k.classList.add('dt-col-tight'); else k.style.width = `${w[c.key]}px`; colgroup.append(k); }
        table.style.tableLayout = 'fixed'; table.style.width = `${Math.max(avail, chk + active.reduce((n, c) => n + w[c.key], 0))}px`;
        box.classList.add('dt-sized'); box.style.setProperty('--dt-sized-min', '0px');
        L0 = { avail, w, prim, hard: prim ? Math.max(ITEM_MIN, minOf(prim)) : 0, others: others + active.reduce((n, c) => n + (isFlex(c) && c !== prim ? w[c.key] : 0), 0), floor, chk, active };
        for (const th of thead.querySelectorAll('th.dt-th')) { const c = columns.find(x => x.key === th.dataset.key), h = th.querySelector('.dt-resize'); if (c && h && w[c.key]) { h.setAttribute('aria-valuenow', String(w[c.key])); h.setAttribute('aria-valuemin', String(minOf(c))); } }
        { const movable = active.filter(x => !fixedW(x)); for (const th of thead.querySelectorAll('th.dt-th')) { const h = th.querySelector('.dt-resize'), at = movable.findIndex(x => x.key === th.dataset.key); if (h) h.hidden = at < 0 || at === movable.length - 1; } } // the last column on show has nothing on its right to give or take room: no handle (#12409)
    }
    /** Move the edge on the right of column c (#12409, Beta Tester on v2.0.35): the edge goes where the pointer goes. c takes the width and the columns on its right give it, the nearest first, each down to its floor (the elastic column down to the name's floor);
     *  a drag the other way gives the room to the nearest. The elastic column is whatever the others leave, so it is never written down; the table keeps its width. `snap` is the layout the drag began on, so a drag that hit a floor and comes back is where it was. */
    function setWidth(c, w, th, snap) {
        applyWidths(); // the room is read from a layout of the box as it is now
        const h = th && th.querySelector('.dt-resize');
        if (!L0) return;
        const S = snap || { w: { ...L0.w } }, cols = L0.active.filter(x => !fixedW(x)), i = cols.indexOf(c), pool = i < 0 ? [] : cols.slice(i + 1);
        if (!pool.length) { if (h) h.setAttribute('aria-valuenow', String(L0.w[c.key] || 0)); return; } // the last column's edge is the table's: nothing on its right to give or take room
        const floorOf = y => (y === L0.prim ? L0.hard : Math.max(minOf(y), y.share ? 96 : 0)), cur = S.w[c.key] || 0, dx = Math.round(w) - cur, change = {};
        let newW = cur;
        if (dx >= 0) { let want = Math.min(dx, MAX_W - cur); for (const y of pool) { if (want <= 0) break; const t = Math.min(want, Math.max(0, (S.w[y.key] || 0) - floorOf(y))); if (t > 0) { change[y.key] = -t; want -= t; newW += t; } } }
        else { const shrink = Math.min(-dx, Math.max(0, cur - (c === L0.prim ? L0.hard : minOf(c)))); newW = cur - shrink; if (shrink > 0) change[pool[0].key] = shrink; }
        if (c !== L0.prim) st.widths[c.key] = Math.round(newW);
        for (const y of pool) if (change[y.key] && y !== L0.prim) st.widths[y.key] = Math.round((S.w[y.key] || 0) + change[y.key]);
        applyWidths();
        if (h) h.setAttribute('aria-valuenow', String(L0 && L0.w[c.key] || Math.round(newW)));
        syncHidden(tightKeys); // the bar offers Reset as soon as a width is kept
    }
    /** Back to the widths nobody dragged: the kept ones go, in this browser too. */
    function resetWidths() { st.widths = {}; saveWidths(); applyWidths(); }
    /** The width the column needs for its widest cell and its head (laid out at its natural width for a moment). */
    function fitWidth(c) { const live = columns.filter(x => !emptyKeys.has(x.key) && !cssHides(x)), n = measureNatural(live)[c.key] || 0; applyWidths(); return Math.min(800, n); }
    /** Fit the column to its content: when that is the width it has, nothing changed and nothing is kept (no Reset appears for it). */
    function fitTo(c, th) {
        const w = fitWidth(c);
        if (Math.abs(w - Math.round(th.getBoundingClientRect().width)) <= 1) return;
        setWidth(c, w, th); saveWidths();
    }
    function resizeHandle(c, th) {
        const h = el('span', 'dt-resize'); h.setAttribute('role', 'separator'); h.setAttribute('aria-orientation', 'vertical'); h.tabIndex = 0; h.dataset.key = c.key;
        h.setAttribute('aria-label', `Resize ${c.label} column`); h.setAttribute('aria-valuemin', String(minOf(c))); h.setAttribute('aria-valuemax', String(MAX_W));
        const now = () => st.widths[c.key] || Math.round(th.getBoundingClientRect().width);
        h.setAttribute('aria-valuenow', String(now()));
        h.addEventListener('click', (e) => e.stopPropagation()); // a drag, or a press on the handle, never sorts
        h.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            h.setPointerCapture(e.pointerId); h.classList.add('dt-resizing');
            applyWidths(); const snap = { w: { ...(L0 ? L0.w : {}) } }, startX = e.clientX, start = snap.w[c.key] || now(); let moved = false;
            const move = (ev) => { if (!moved) { if (Math.abs(ev.clientX - startX) < 2) return; moved = true; } setWidth(c, start + (ev.clientX - startX), th, snap); }; // a press that does not move changes nothing: no frozen widths, no Reset
            const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); h.classList.remove('dt-resizing'); if (moved) saveWidths(); };
            h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
        });
        h.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); fitTo(c, th); }); // fit the column to its content
        h.addEventListener('keydown', (e) => {
            const step = e.shiftKey ? STEP * 3 : STEP;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setWidth(c, now() + (e.key === 'ArrowRight' ? step : -step), th); saveWidths(); }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); fitTo(c, th); }
        });
        return h;
    }

    const sortable = columns.filter(c => c.sort);
    const sortedOnly = () => {
        const s = st.sort && columns.find(c => c.key === st.sort.key);
        if (!s || !s.sort || cfg.onSort) return rows;
        const cmp = compareBy(s), dir = st.sort.dir === 'desc' ? -1 : 1;
        return rows.slice().sort((a, b) => dir * cmp(a, b));
    };
    /** keepOrder (#12636): a list that fills in as computers answer keeps the order the person is looking at under every sort: a row already shown stays where it is, a new row goes after them, and a different
    *  sort (or cfg.orderKey, the caller's own search and filters) starts the order afresh. Only under a header sort: with none, the caller's order stands. The memory is in the table's state, so it survives the redraws. */
    const sortedRows = () => {
        const out = sortedOnly();
        if (!cfg.keepOrder || !cfg.rowKey || !st.sort) { st.shown = null; return out; } // with no header sort the caller's own order stands (the Needs you list keeps it, keepOrder in needs_filters.js)
        const sig = JSON.stringify([st.sort ? [st.sort.key, st.sort.dir] : null, cfg.orderKey || '']), rank = st.shown && st.shown.sig === sig ? st.shown.rank : new Map();
        const seen = [], fresh = [];
        for (const r of out) (rank.has(cfg.rowKey(r)) ? seen : fresh).push(r);
        seen.sort((a, b) => rank.get(cfg.rowKey(a)) - rank.get(cfg.rowKey(b)));
        const kept = [...seen, ...fresh];
        st.shown = { sig, rank: new Map(kept.map((r, i) => [cfg.rowKey(r), i])) };
        return kept;
    };

    // Column sizing (#9846, design note rules 3 to 5), all optional: min and max in characters (ch follows the text size), share (the part of the leftover width a flexible column takes: Item 2, Goal 1), fixed (a column
    // that is never shrunk: Actions, its width is its minimum). The first resize still freezes the widths as before; these are the defaults a list starts from.
    const shareTotal = columns.reduce((n, c) => n + (c.share || 0), 0);
    function sizeColumn(c, node) {
        const ATTR = { min: 'data-dt-min', max: 'data-dt-max', w: 'data-dt-w' };
        const set = (name, v) => { node.style.setProperty(`--dt-${name}`, v); node.setAttribute(ATTR[name], ''); }; // custom properties, read by data_table.css only while the table is not folded: a folded (phone) row lays its cells out its own way
        if (c.min) set('min', `var(--dt-sized-min, min(${c.min}ch, 40cqw))`); // a table with widths of its own sets --dt-sized-min on its box: it is sized in pixels and fits the box, so the name column gives room down to its floor, not down to its characters (#11835) // never more than 40% of the table's box (of the screen where it is not a container): the dock's Tasks table (State, Task, Who) was wider than its box with the name at 24 characters, on a 390 px phone and at 200% text in the 680 px dock (#9917)
        if (c.max) set('max', `${c.max}ch`);
        if (c.fixed && c.width && /rem$/.test(c.width)) { set('min', c.width); set('max', 'none'); set('w', c.width); }
        if (c.share) { set('w', `${Math.round(90 * c.share / shareTotal)}%`); if (!c.max) set('max', '0'); }
        if (c.width === 'grow' && !c.primary && !c.max) node.style.setProperty('--dt-nat-max', '560px'); // a grow column that is not the name: its natural width, measured by applyWidths, is its text up to this // a share column is bounded (max-width 0 with its min-width above it): in an auto layout its no-wrap text otherwise sets the column to the width of the text and the table scrolls sideways (UI Accessibility, #9856)
    }

    const attrEsc = v => String(v).replace(/["\\]/g, '\\$&'); // a column key inside a quoted attribute selector
    // A column no row has anything in is not drawn (#9846, the design note's rule 2): its head and its cells are hidden, and it is back the moment a row has a value. Never the name, an action or the selection column.
    const isEmptyCell = td => !/[^\s\u2014\u2013-]/.test(td.textContent || '') && !td.querySelector('button, a, input, select, img, svg, .material-icons');
    function syncEmptyColumns() {
        if (mailOn()) return;
        const trs = [...tbody.querySelectorAll(':scope > .dt-row')], next = new Set();
        if (trs.length) for (const c of columns) {
            if (c.primary || c.hideWhenEmpty === false || c.hideLabel || c.key === 'review' || c.key === 'actions') continue;
            if (trs.every(tr => { const td = tr.querySelector(`:scope > td[data-key="${attrEsc(c.key)}"]`); return !td || isEmptyCell(td); })) next.add(c.key);
        }
        if (next.size === emptyKeys.size && [...next].every(k => emptyKeys.has(k))) return;
        emptyKeys = next;
        for (const th of thead.querySelectorAll('th.dt-th')) th.classList.toggle('dt-col-unused', emptyKeys.has(th.dataset.key));
        for (const td of tbody.querySelectorAll(':scope > .dt-row > td.dt-td')) { td.classList.toggle('dt-col-unused', emptyKeys.has(td.dataset.key)); td.style.display = emptyKeys.has(td.dataset.key) ? 'none' : ''; } // display-ok: inline, because a folded row's own display: block wins over the class and an empty cell was a 16 px line (#11858)
        applyWidths();
    }

    function drawHead() {
        thead.replaceChildren();
        const tr = el('tr'); tr.setAttribute('role', 'row');
        if (sel) { const th = el('th', 'dt-check'); th.setAttribute('role', 'columnheader'); const all = el('input'); all.type = 'checkbox'; all.className = 'check dt-check-all'; all.setAttribute('aria-label', 'Select all rows on this page'); all.addEventListener('change', () => { for (const r of rows.filter(eligible)) (all.checked ? st.selected.add(keyOf(r)) : st.selected.delete(keyOf(r))); st.anchor = null; syncSelection(); }); th.append(checkHit(all)); tr.append(th); }
        for (const c of columns) {
            const th = el('th', `dt-th${c.numeric || c.align === 'end' ? ' dt-end' : ''}`); th.scope = 'col'; th.setAttribute('role', 'columnheader'); th.dataset.key = c.key;
            if (cfg.oneLine && c.dropAt) th.setAttribute('data-drop-at', String(c.dropAt));
            if (c.tiny) th.setAttribute('data-tiny', 'hide');
            if (c.width && /rem$/.test(c.width)) th.style.width = c.width;
            sizeColumn(c, th);
            if (c.width === 'grow') th.classList.add('dt-grow');
            if (c.width === 'content') th.classList.add('dt-content');
            if (c.narrowHide) th.classList.add('dt-narrow-hide');
            if (c.sort) {
                const on = st.sort && st.sort.key === c.key;
                th.setAttribute('aria-sort', on ? (st.sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');
                const b = button('dt-sort', null, () => sortBy(c)); b.dataset.key = c.key; b.setAttribute('aria-label', /, \d+$/.test(String(cfg.label || '')) ? c.label : `${c.label}, ${cfg.label}`); // named for its column and its table: "Cost" is not six buttons that read the same (#6432); a list that is the page's one table (its name ends in its count, "Needs you, 1") says the column alone, not its own name and count on every header (#10374)
                b.append(el('span', null, c.label), el('span', 'dt-arrow', on ? (st.sort.dir === 'desc' ? '↓' : '↑') : '↕')); b.lastChild.setAttribute('aria-hidden', 'true');
                th.append(b);
            } else th.append(el('span', c.hideLabel ? 'sr-only' : 'dt-head-text', c.label)); // hideLabel: a column that is only an action has no head text on screen, its name is for a reader
            if (c.filter) { // a column the rows are narrowed by: filter = { label, active() -> bool, open(button) }; the surface owns the choice list, the header owns the button
                const f = button(`dt-filter${c.filter.active() ? ' dt-filter-on' : ''}`, null, (e) => { e.stopPropagation(); c.filter.open(f); });
                f.setAttribute('aria-label', c.filter.label); f.title = 'Filter';
                const icon = el('span', 'material-icons', 'filter_list'); icon.setAttribute('aria-hidden', 'true'); f.append(icon);
                th.append(f);
            }
            if (cfg.resize !== false && c.resize !== false && !c.fixed) { const rh = resizeHandle(c, th); rh.hidden = !columns.slice(columns.indexOf(c) + 1).some(x => !x.fixed && !fixedW(x)); th.append(rh); } // the last column has no handle on show: its right edge is the table's (#12409; applyWidths hides and shows it with the layout)
            if (cfg.decorateHead) cfg.decorateHead(th, c);
            if (emptyKeys.has(c.key)) th.classList.add('dt-col-unused');
            tr.append(th);
        }
        thead.append(tr);
        drawSortBar();
    }

    function drawSortBar() {
        sortBar.replaceChildren();
        if (!sortable.length) { sortBar.hidden = true; return; } // nothing to sort by (a list in its own order, the chats): no empty bar above the rows
        const id = `dt-sort-${Math.random().toString(36).slice(2, 8)}`;
        const label = el('label', 'dt-sortbar-label', 'Sort by'); label.htmlFor = id;
        const select = el('select', 'dt-sortbar-select'); select.id = id;
        if (!st.sort && cfg.defaultSortLabel) { const o = el('option', null, cfg.defaultSortLabel); o.value = ''; o.disabled = true; select.append(o); }
        for (const c of sortable) { const o = el('option', null, c.label); o.value = c.key; select.append(o); }
        select.value = (st.sort && st.sort.key) || (cfg.defaultSortLabel ? '' : sortable[0].key);
        select.addEventListener('change', () => { const c = columns.find(x => x.key === select.value); st.sort = null; sortBy(c, true); });
        const dir = button('btn dt-sortbar-dir', st.sort && st.sort.dir === 'desc' ? 'Descending' : 'Ascending', () => { const c = columns.find(x => x.key === select.value); sortBy(c); });
        dir.hidden = !st.sort && !!cfg.defaultSortLabel;
        sortBar.append(label, select, dir);
    }

    function sortBy(c, keepDir) {
        const same = st.sort && st.sort.key === c.key;
        st.sort = { key: c.key, dir: same && !keepDir ? (st.sort.dir === 'asc' ? 'desc' : 'asc') : (same ? st.sort.dir : (c.firstDir || 'asc')) };
        if (cfg.onSort) { cfg.onSort(st.sort.key, st.sort.dir); return; }
        const held = document.activeElement && document.activeElement.classList.contains('dt-sort') ? document.activeElement.dataset.key : '';
        drawHead(); drawBody();
        if (held) thead.querySelector(`.dt-sort[data-key="${CSS.escape(held)}"]`)?.focus({ preventScroll: true });
    }

    function cellOf(c, r, tr) {
        const td = el('td', `dt-td dt-tone-${c.tone || (c.primary ? 'primary' : 'secondary')}${c.numeric || c.align === 'end' ? ' dt-end' : ''}${c.nowrap === false ? ' dt-wrap' : ''}`);
        if (c.width === 'grow') td.classList.add('dt-grow');
        if (c.lineGrow) td.classList.add('dt-line-grow'); // a second line that takes its whole line in a folded row, without being the table's elastic column (#11943)
        if (c.width === 'content') td.classList.add('dt-content');
        sizeColumn(c, td);
        td.setAttribute('role', 'cell'); td.dataset.label = c.label; td.dataset.key = c.key;
        if (cfg.oneLine && c.dropAt) td.setAttribute('data-drop-at', String(c.dropAt));
        if (c.tiny) td.setAttribute('data-tiny', 'hide');
        td.classList.add(c.line === 1 ? 'dt-line-1' : c.line === 2 ? 'dt-line-2' : 'dt-line-0');
        if (c.foldLabel) td.setAttribute('data-fold-label', c.label); // the folded row has no header: the column's name is drawn before the figure (data_table.css, as text; foldLabel: true, #11463)
        if (c.when && !c.when(r)) td.classList.add('dt-when-off');
        if (emptyKeys.has(c.key)) { td.classList.add('dt-col-unused'); td.style.display = 'none'; } // display-ok: as in syncEmptyColumns
        if (c.foldFirst) td.classList.add('dt-fold-first');
        if (st.sort && st.sort.key === c.key) td.classList.add('dt-fold-key'); // folded 'labeled': the figure the rows are sorted by is the one stronger line (#7738)
        if (c.narrowHide) td.classList.add('dt-narrow-hide'); // folded 'labeled': this figure follows the name, ahead of the other "label value" lines
        let v = c.cell ? c.cell(r, ctx, { open: () => (cfg.open ? cfg.open(r, tr) : undefined), hasOpen: !!cfg.open }) : (c.field != null ? r[c.field] : ''); // a cell's third argument: { open(), hasOpen } is the row's own open, for a button in the cell that opens what the row opens
        if (typeof v === 'string' && c.primary) v = primaryButton(v, `Open ${v}`);
        if (v instanceof Node) td.append(v); else td.textContent = v == null ? '' : String(v);
        if (c.title) { const t = c.title(r); if (t) td.title = t; } // the full name or id on hover
        if (c.subtitle) { const s = c.subtitle(r); if (s) { const sub = el('span', 'dt-subtitle', s); if (c.subtitleTitle) { const t = c.subtitleTitle(r); if (t) tipIf(sub, t, () => t !== s || sub.scrollWidth > sub.clientWidth); } td.append(sub); } } // subtitleTitle(row): the whole line on hover when the subtitle is cut with an ellipsis
        return td;
    }

    // detail (#7903): one more full-width row under each row, hidden until the surface says it is open; the toggle that opens it is a button in one of the row's cells (aria-expanded, aria-controls: the detail's id)
    function detailRow(r, k, cols) {
        const d = cfg.detail, tr = el('tr', 'dt-detail'); tr.setAttribute('role', 'row'); tr.dataset.detailFor = k;
        const id = d.id && d.id(r); if (id) tr.id = id;
        tr.hidden = !(d.open && d.open(r));
        const td = el('td', 'dt-detail-cell'); td.setAttribute('role', 'cell'); td.colSpan = cols;
        td.append(d.render(r));
        tr.append(td);
        return tr;
    }

    // the titles two rows share: those rows say their team after the title (a Goals or Tasks row has no other room for it, UI/UX #9654)
    let _dups = null; const dupTitles = () => { if (!_dups) { const seen = new Set(); _dups = new Set(); for (const r of rows) { const t = cfg.mail(r).title; if (seen.has(t)) _dups.add(t); seen.add(t); } } return _dups; };
    function drawBody() {
        _dups = null;
        tbody.replaceChildren();
        const list = sortedRows();
        const cols = columns.length + (sel ? 1 : 0);
        let lastGroup = null;
        const mails = mailOn() ? list.map(r => cfg.mail(r)) : null, gap = !!mails && mails.some(m => m.actions && m.actions.length); // a list with a ⋯ on any row reserves its 44 px on every row, so the times line up (#137104)
        list.forEach((r, i) => {
            if (cfg.groupBy && !st.sort) { // the rows come in the caller's order: a divider where their group changes (a day), none once the person has sorted
                const g = cfg.groupBy(r);
                if (g && g.key !== lastGroup) { lastGroup = g.key; const gr = el('tr', 'dt-group'); gr.setAttribute('role', 'row'); const gh = el('th', null, g.label); gh.colSpan = cols; gh.scope = 'rowgroup'; gh.setAttribute('role', 'rowheader'); gr.append(gh); tbody.append(gr); }
            }
            const k = keyOf(r), tr = el('tr', 'dt-row'); tr.setAttribute('role', 'row'); tr.dataset.key = k;
            if (cfg.unread && cfg.unread(r)) tr.classList.add('dt-unread'); // a desktop row the person has not opened since it changed (#9687)
            if (cfg.quiet && cfg.quiet(r)) tr.classList.add('dt-quiet'); // a row that is not a finding (usage whose level was not recorded): quieter than the rest
            if (sel) {
                const td = el('td', 'dt-check'); td.setAttribute('role', 'cell');
                const cb = el('input', 'check'); cb.type = 'checkbox'; cb.setAttribute('aria-label', `Select ${nameOf(r)}`); cb.dataset.idx = String(i); cb.disabled = !eligible(r); if (cb.disabled) cb.hidden = true;
                cb.addEventListener('click', (e) => {
                    if (!eligible(r)) return;
                    const on = cb.checked;
                    if (e.shiftKey && st.anchor != null && st.anchor !== i) { const [a, b] = st.anchor < i ? [st.anchor, i] : [i, st.anchor]; for (let j = a; j <= b; j++) if (eligible(list[j])) (on ? st.selected.add(keyOf(list[j])) : st.selected.delete(keyOf(list[j]))); }
                    else (on ? st.selected.add(k) : st.selected.delete(k));
                    st.anchor = i; syncSelection();
                });
                td.append(cb.hidden ? cb : checkHit(cb)); tr.append(td);
            }
            if (mailOn()) {
                const m = mails[i], showTeam = !!m.team && (m.teamAlways || dupTitles().has(m.title));
                const pick = sel && eligible(r) ? () => { const cb = tr.querySelector('.dt-check input'); if (!cb) return; if (!st.select) { st.select = true; st.mailSelect = true; syncSelectMode(); } cb.dispatchEvent(new MouseEvent('click', { bubbles: true })); } : null;
                tr.classList.add('dt-mailed'); tr.append(mailCell(m, nameOf(r), !!cfg.open, pick, showTeam, gap));
            } else for (const c of columns) tr.append(cellOf(c, r, tr));
            if (sel && sel.longPress && eligible(r)) { // a touch screen: pressing a row and holding it selects it, and a tap adds more (#11671); the tap that ends the press is not a tap on the row
                let timer = 0, from = null;
                const stop = () => { clearTimeout(timer); timer = 0; from = null; };
                tr.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch' || e.target.closest('.dt-check')) return; from = { x: e.clientX, y: e.clientY };
                    timer = setTimeout(() => { timer = 0; const cb = tr.querySelector('.dt-check input'); if (!cb) return;
                        if (!st.select) { st.select = true; st.mailSelect = true; syncSelectMode(); } cb.dispatchEvent(new MouseEvent('click', { bubbles: true })); navigator.vibrate?.(8);
                        const mute = ev => { ev.stopPropagation(); ev.preventDefault(); document.removeEventListener('click', mute, true); }; document.addEventListener('click', mute, true); setTimeout(() => document.removeEventListener('click', mute, true), 800); }, 450); }); // after the selecting click, and on the document: the rows move when the checks appear, so the lift of the finger can land on another row
                tr.addEventListener('pointermove', e => { if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 8) stop(); });
                for (const type of ['pointerup', 'pointercancel', 'pointerleave']) tr.addEventListener(type, stop);
                tr.addEventListener('contextmenu', e => { if (timer || st.select) e.preventDefault(); }); // the long press is ours, not the browser's menu
            }
            if (cfg.open) {
                tr.classList.add('dt-row-open');
                tr.addEventListener('click', (e) => {
                    if (e.target.closest(INTERACTIVE)) return;
                    if (sel && box.classList.contains('dt-folded') && st.select) { const cb = tr.querySelector('.dt-check input'); if (cb) cb.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: e.shiftKey })); return; } // a click event on a checkbox toggles it itself
                    cfg.open(r, tr);
                });
            }
            if (cfg.current != null && cfg.current === k) tr.setAttribute('aria-current', 'true');
            tbody.append(tr);
            const dr = cfg.detail ? detailRow(r, k, cols) : null;
            if (dr) tbody.append(dr);
            if (cfg.decorate) cfg.decorate(r, tr, dr); // the surface's own hooks on a row it owns (an id, a class a deep link reads, a key handler): called again whenever the rows are drawn again, a sort included
        });
        syncEmptyColumns();
        applyWidths();
        syncSelection(true);
    }

    function syncSelection(quiet) {
        if (!sel) return;
        const present = new Set(rows.map(keyOf));
        for (const tr of tbody.querySelectorAll(':scope > .dt-row')) { const on = st.selected.has(tr.dataset.key); tr.classList.toggle('dt-selected', on); tr.setAttribute('aria-selected', String(on)); const cb = tr.querySelector('.dt-check input'); if (cb) cb.checked = on; tr.querySelector('.dt-mail-lead')?.setAttribute('aria-checked', String(on)); }
        if (st.mailSelect && !st.selected.size) { st.select = false; st.mailSelect = false; syncSelectMode(); } // selecting began with an avatar and the last row was unselected: a tap opens a row again
        const all = thead.querySelector('.dt-check-all');
        if (all) { const available = rows.filter(eligible), n = available.filter(r => st.selected.has(keyOf(r))).length; all.disabled = !available.length; all.checked = n > 0 && n === available.length; all.indeterminate = n > 0 && n < available.length; }
        drawBar();
        if (!quiet && sel.onChange) sel.onChange(new Set(st.selected));
        void present;
    }

    function drawBar() {
        const n = st.selected.size;
        bar.hidden = n === 0; bar.replaceChildren();
        live.textContent = n ? `${n} selected` : '';
        if (!n) { st.confirming = -1; st.choices = null; return; }
        const icons = !!sel.iconBar && st.confirming < 0; // a phone's bar is one line (#11707): Cancel (X), "N selected", icon buttons, and a More menu for the rest; the confirm step keeps words
        bar.classList.toggle('dt-bar-icons', !!sel.iconBar);
        if (icons) { const x = button('btn btn-quiet btn-icon ic-close dt-bar-cancel', '', () => clear()); x.setAttribute('aria-label', sel.clearLabel || 'Clear'); x.title = sel.clearLabel || 'Clear'; bar.append(x); }
        if (!(sel.iconBar && st.confirming >= 0)) bar.append(el('span', 'dt-bar-count', `${n} selected`));
        const actions = sel.actions || [];
        const chosen = () => [...st.selected].map(k => st.rowCache.get(k)).filter(Boolean);
        const press = (a, i) => async () => {
            if (a.choose) { st.choices = await a.choose.options(); st.confirming = i; drawBar(); bar.querySelector(a.danger ? '.dt-bar-keep' : '.dt-bar-choice')?.focus(); return; } // an action that needs a value (a person, a priority) asks for it here
            if (a.danger || a.askWhen?.(chosen().length, chosen())) { st.confirming = i; drawBar(); bar.querySelector('.dt-bar-keep')?.focus(); return; } // askWhen(n, rows): an action that asks only for some selections (Approve of several files), in the same Keep / confirm step, not red
            a.run(chosen(), new Set(st.selected));
        };
        const more = [];
        actions.forEach((a, i) => {
            if (st.confirming >= 0) return; // while one asks, the others wait
            if (a.hidden?.(chosen())) return; // an action that makes no sense for what is selected is not offered, not shown dimmed (#12401: Changes on a goal)
            if (icons && a.more) { more.push([a, i]); return; }
            const action = icons && a.icon ? button('btn btn-quiet btn-icon dt-bar-action dt-bar-icon', '', press(a, i)) : button(`btn btn-small dt-bar-action${a.danger ? ' dt-danger' : ''}`, a.label, press(a, i));
            if (icons && a.icon) { action.append(a.icon()); action.setAttribute('aria-label', a.label); action.title = a.label; }
            action.disabled = !!a.disabled?.(chosen()); bar.append(action);
        });
        if (more.length) { // the rest of the actions behind one three-dot button (menu_button.js: arrow keys, Escape, a tap elsewhere closes)
            const id = `dt-bar-more-${n}`, wrap = el('span', 'dt-bar-more'), toggle = button('btn btn-quiet btn-icon ic-more dt-bar-more-toggle', '', async e => { e.stopPropagation(); const m = await importOnce('./menu_button.js'), live = toggle.isConnected ? toggle : bar.querySelector('.dt-bar-more-toggle'); if (live) m.toggleMenu(live); }); // the module loads on the first tap: a refresh that redrew the bar meanwhile replaced this button, so the menu opens on the one now in the bar (v2.0.24: More did nothing after two swipes)
            toggle.id = id; toggle.setAttribute('aria-haspopup', 'menu'); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', `${id}-menu`); toggle.setAttribute('aria-label', 'More actions'); toggle.title = 'More actions';
            const menu = el('div', 'menu dt-mail-menu'); menu.id = `${id}-menu`; menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'More actions');
            for (const [a, i] of more) { const it = button('menu-item', a.label, async e => { e.stopPropagation(); (await importOnce('./menu_button.js')).closeMenus({ restoreFocus: true }); press(a, i)(); }); it.setAttribute('role', 'menuitem'); it.disabled = !!a.disabled?.(chosen()); menu.append(it); }
            wrap.append(toggle, menu); bar.append(wrap);
            importOnce('./menu_button.js').catch(() => {}); // loaded as the bar appears, so the first tap on the three dots never waits on it (a failed load is tried again by the tap)
        }
        if (st.confirming >= 0) {
            const a = actions[st.confirming];
            if (a.choose) {
                const pick = el('select', 'dt-bar-choice'); pick.setAttribute('aria-label', a.choose.label);
                for (const o of st.choices || []) { const op = el('option', null, o.label); op.value = o.value; pick.append(op); }
                const text = a.choose.text ? el('input', 'dt-bar-text') : null;
                if (text) { text.type = 'text'; text.setAttribute('aria-label', a.choose.text.label); text.placeholder = a.choose.text.label; text.maxLength = a.choose.text.maxLength || 300; text.required = true; }
                const apply = button(`btn btn-small dt-bar-apply${a.danger ? ' dt-danger' : ''}`, a.danger ? a.label : 'Apply', () => { if (text && !text.value.trim()) { text.reportValidity(); return; } const v = pick.value; st.confirming = -1; st.choices = null; a.run(chosen(), new Set(st.selected), v, text?.value.trim()); });
                if (text) { apply.disabled = true; text.addEventListener('input', () => { apply.disabled = !text.value.trim(); }); }
                const ask = typeof a.confirm === 'function' ? a.confirm(n, chosen()) : a.confirm || `${a.label}:`;
                const step = el('div', 'dt-bar-step');
                step.append(el('span', 'dt-bar-confirm', ask), pick); if (text) step.append(text);
                step.append(button('btn btn-small dt-bar-keep', 'Keep', () => { st.confirming = -1; st.choices = null; drawBar(); }), apply);
                bar.append(step);
            } else {
                const ask = el('span', 'dt-bar-confirm', typeof a.confirm === 'function' ? a.confirm(n, chosen()) : (a.confirm || `${a.label}?`)); ask.setAttribute('role', 'alert');
                bar.append(ask, button('btn btn-small dt-bar-keep', 'Keep', () => { st.confirming = -1; drawBar(); }), button(`btn btn-small${a.danger ? ' dt-danger' : ''}`, a.label, () => { st.confirming = -1; a.run(chosen(), new Set(st.selected)); }));
            }
        }
        if (!sel.iconBar) bar.append(button('btn btn-small dt-bar-clear', sel.clearLabel || 'Clear', () => clear())); // the icon bar has its Cancel first
    }

    function clear() { st.selected.clear(); st.anchor = null; st.confirming = -1; st.choices = null; syncSelection(); }
    function syncSelectMode() { box.classList.toggle('dt-selecting', st.select); selectButton.textContent = st.select ? 'Done' : 'Select'; selectButton.setAttribute('aria-pressed', String(st.select)); }

    drawHead(); drawBody(); syncSelectMode(); applyWidths();
    if (!rows.length && cfg.empty) {
        const e = el('div', 'empty-state'); e.append(el('p', 'empty-state-line', cfg.empty.line));
        if (cfg.empty.hint) e.append(el('p', 'empty-state-hint', cfg.empty.hint));
        if (cfg.empty.action) e.append(button('btn', cfg.empty.action.label, cfg.empty.action.run));
        box.replaceChildren(e);
    } else if (cfg.footer && !(cfg.footer.auto && !cfg.footer.more)) { // footer.auto (#7937): a count line that says all rows are shown says nothing, so with nothing more to load the footer is not drawn
        const foot = el('div', 'dt-foot'); foot.append(el('span', 'dt-foot-text', cfg.footer.text || ''));
        if (cfg.footer.more) {
            const m = button('btn dt-more', cfg.footer.more.busy ? 'Loading…' : cfg.footer.more.label, cfg.footer.more.run); if (cfg.footer.more.busy) m.setAttribute('aria-busy', 'true'); foot.append(m);
            // footer.auto: more rows come when the footer scrolls into view (a long list that is read, not paged by hand); the button stays for the keyboard
            if (cfg.footer.auto && !cfg.footer.more.busy && typeof IntersectionObserver === 'function') { const io = new IntersectionObserver((es) => { if (es.some(e => e.isIntersecting)) { io.disconnect(); cfg.footer.more.run(); } }, { rootMargin: '300px' }); io.observe(foot); }
        }
        box.append(foot);
    }

    // before the box has a width (it is built apart from the page) a window narrower than THIS table's fold starts it folded: a first paint of the wide table would scroll the page sideways (#7868). Only that window: one that is wider
    // than the fold (a 481-760 px one among them) is left unfolded, or the observer below would unfold it a frame later, a flash (#7994). A box that already has a width is judged by it. The observer then settles every case.
    if (cfg.fold !== 'none') { const root0 = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; const known = box.clientWidth; if (cfg.fold === 'always' || (known ? known : window.innerWidth) < foldAt * root0) box.classList.add('dt-folded'); }
    // folded: the table's own box narrower than foldAt rem (the root font size is read, so a larger text size folds sooner); set before the first paint
    if (cfg.fold !== 'none' && typeof ResizeObserver === 'function') {
        const root = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const syncFold = () => {
            const w = box.clientWidth; if (!w) return;
            let on = cfg.fold === 'always' || w < foldAt * root();
            if (foldAt === 'fit' && cfg.fold !== 'always') {
                // Measure the actual table in its available width, before paint. Names may
                // ellipsize; headers and metadata must fit without clipping or sideways scroll.
                box.classList.remove('dt-folded'); applyWidths();
                on = table.getBoundingClientRect().width > w + 1;
            }
            box.classList.toggle('dt-folded', on);
            box.classList.toggle('dt-tiny', w < 20 * root()); // a phone at large text: the columns that say tiny: true go, so the name keeps its room (20 rem is a 390 px screen at 200% text)
        };
        new ResizeObserver(() => { syncFold(); }).observe(box);
        if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(syncFold); // fonts already in: the observer's first call settles it before the paint; calling it now read the width of a box not yet laid out, a forced layout (#9450)
    }
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => applyWidths()).observe(box); // every column is laid out again whenever the box changes (the elastic column takes what the others leave)
    mailQuery?.addEventListener?.('change', () => { box.classList.toggle('dt-mail-on', mailOn()); drawBody(); cfg.onModeChange?.(); }); // the window crosses the phone's width: the rows are drawn again in the other form; a list whose selection exists on a phone only (selectable is decided when the spec is drawn) asks its owner to draw the table again
    return { el: box, bar, selectButton, selection: () => new Set(st.selected), clear, state: st };
}
