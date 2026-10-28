/* The one table (#7743): every list or table surface passes what to show, the component owns how it looks and behaves. The operator's rule: a styling change is one token or one rule, so every size and colour here
 * is a --table-* token (css/data_table.css) and no surface styles a row, a cell or a header.
 *
 *   dataTable({ label, columns, rows, rowKey, groupBy(row) -> { key, label }, open, current, state, onSort, layout, fold, foldAt, sortBar, defaultSortLabel, bare, empty, footer, selectable, rowName, quiet, scroll, detail, decorate, decorateHead }) -> { el, bar, selectButton, selection(), clear(), state }
 *   selectable = { contextKey, onChange(keys), actions: [{ label, run(rows, keys, value), danger, confirm, choose: { label, options() -> [{ value, label }] } }] }: a danger action confirms in the bar, a choose action asks for its value there.
 *   Column = { key, label, field | cell(row, ctx), primary, tone: 'primary'|'secondary'|'tertiary', width: 'grow'|'content'|'<n>rem', fixed (with a rem width: that width, no resize handle, never squeezed or kept: a list's Actions, #9845), nowrap, align: 'start'|'end', numeric,
 *              sort: true|'number'|'date'|fn(a, b), sortValue(row), firstDir: 'asc'|'desc', foldFirst, narrowHide, line: 0|1|2, when(row), subtitle(row), subtitleTitle(row), title(row), filter: { label, active(), open(button) }, hideLabel }
 *   column widths (#7949): every header has a resize handle on its right edge (drag, Left and Right keys, double-click or Enter to fit the content); the widths are kept per list in this browser (widthsKey, else the label without its row count), and there is no reset button: a double click on a column edge fits it to its content (#9845). minWidth per column (64 px by default), resize: false for one that must not.
 *   detail = { id(row), open(row) -> bool, render(row) -> Node }: a second full-width row under each row (hidden while open(row) is false); the surface's own toggle in a cell opens it (Coral Hub's Servers: health, what applies).
 *   decorate(row, tr, detailTr) and decorateHead(th, column): called each time the rows (or the header) are drawn, for the hooks a surface keeps on them.
 *   cell types: chip(word, cls), avatar(name), avatars(people, label), personButton(name, label), tag(text), timeCell(stamp), link(text, run), primaryButton(text, label)
 *   oneLine: true: keep one row, hide columns with dropAt 62/52/36/28/16 (rem) as the container narrows; never fold.
 *   wrapNames: true (with oneLine): in a narrow table the name wraps at its words, to two or three lines, rather than ending in an ellipsis mid-word (the Automations lists).
 *   compact: true: a folded column row is two compact lines (60 px; the name on one line): the Tasks lists and the dock's Artifacts ask for it (#8496); other folded tables keep two-line names and descriptions.
 *   state: tableState(), kept by the caller across redraws: the sort, and the selection (a set of row keys, kept while the rows are filtered or paged, cleared when selectable.contextKey changes).
 * Folded (the table's own box narrower than foldAt rem, 40 by default; 'fit' measures the unfolded columns; also at 200% text): fold 'column' is the two-line row (line 1 and line 2 cells), fold 'labeled' is the name, then "label value" lines
 * (the Analytics tables); scroll: a table of many columns scrolls sideways inside its box, shaded where more is to come, rather than being cut off; the header row is hidden and a "Sort by" select takes its place. Everything is built with the DOM and textContent: titles and names are written by agents. */
import { whenText, shortWhen } from './when_text.js';
import { browserLocal } from './safe_storage.js';

export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const button = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

/** A select box with its 44 px target (#9576): the box is 16 px, so a label around it is what a finger hits (a touch screen's census counts a checkbox as its label); the label's own click is the box's and goes no further (the row's handler would open the row). */
const checkHit = input => { const l = el('label', 'dt-check-hit'); l.append(input); l.addEventListener('click', e => e.stopPropagation()); return l; };

export const tableState = () => ({ widths: null, sort: null, selected: new Set(), rowCache: new Map(), anchor: null, ctx: undefined, select: false, confirming: -1 });

// ── cell types ────────────────────────────────────────────────────────────
/** The row's one real button: its text names the row. */
export function primaryButton(text, label) {
    const b = el('button', 'dt-primary', text); b.type = 'button';
    b.title = text; // a name the row cuts with an ellipsis is read whole on hover (#8206); a caller with better words sets its own
    if (label) b.setAttribute('aria-label', label);
    return b;
}
/** A state as a dot and a word (the dot is decoration: the word says it). */
export function chip(word, cls) {
    const c = el('span', `chip dt-chip goal-chip ${cls || ''}`.trim());
    const dot = el('span', 'goal-dot'); dot.setAttribute('aria-hidden', 'true');
    c.append(dot, document.createTextNode(word));
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
    w.append(a, el('span', 'dt-person-name', text || n)); // text: what is said beside the circle when it is more than the name ("Done by Dev")
    return w;
}
/** People as a row of circles and nothing else (the Tasks table's Assigned to, #8492): the person responsible first, one solid circle; then reviewers as smaller outlined circles, at most two, then "+N". The whole cell is one image named by label
 *  ("Done by Dev, reviewed by QA"), which is also its hover text, so the column is as narrow as its circles. people = [{ name, review? }]. */
export function avatars(people, label) {
    const w = el('span', 'dt-person dt-avatars'); w.setAttribute('role', 'img'); w.setAttribute('aria-label', label); w.title = label;
    const circle = (name, cls) => { const n = String(name || '').trim(); const a = el('span', `dt-avatar${cls}`, [...n][0].toUpperCase()); a.setAttribute('aria-hidden', 'true'); a.style.setProperty('--dt-avatar-bg', `var(--avatar-${(hash(n.toLowerCase()) % 8) + 1})`); return a; };
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
 *  A caller opts in with `mail(row) -> { lead: { text, name?, square?, icon? }, title, snippet?, state?, ask?, time?, unread?, mark?, data?, tip?, team?, teamAlways?, nameTeam?, snippetTip? }` (nameTeam: the team is in the button's name but not drawn on the line, so Needs you is one line, #9986) (state: the word the row shows for what it is in (a task's Queued, In review), said in the button's name after the title, so a screen reader hears <name>, <state> (#9747)) (team: after the title in tertiary, always when teamAlways, else only for a title two rows share) (data: attributes for the open button, as `{ taskId: 5 }` is data-task-id="5"); on a phone the row is this cell alone (the columns are the desktop's), and its button is the row's open control.
 *  `unread` makes the title 600 (a read one is 500) and draws an accent dot under the time that is named "Unread" for a screen reader: a list says it only where a read state exists (Needs you; chats, boards and tasks through inbox_read.js, #9687). `mark: 'attention'` is the amber dot under the time and outranks the unread dot (one dot a row). A desktop table takes `unread(row)` for the same look as a `dt-unread` row. Text is set with textContent only. */
const MAIL_QUERY = '(max-width: 767px)';
const mailCell = (m, label, open, pick, showTeam = false) => { // open: the row opens (a button), pick: a function that selects it, or null, showTeam: the team is drawn after the title (always for Needs you, and for a title two rows share)
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
    if (open) { body.type = 'button'; body.dataset.rowName = label; { const named = ((showTeam || m.nameTeam) && m.team ? `${label}, ${m.team}` : label) + (m.state ? `, ${m.state}` : '') + (m.starred && !/, starred$/.test(String(label)) ? ', starred' : '') + (m.live ? `, ${m.live.toLowerCase()}` : ''); body.setAttribute('aria-label', (m.unread && !m.mark ? `${named}, unread` : named) + (m.time && !String(named).includes(m.time) ? `, ${m.time}` : '')); } } // the name holds every word the row shows (the time too), so a visible label is in its name; its click is the row's (a .dt-primary button is not interactive to the row's handler: it opens, or toggles while selecting)
    const text = el('span', 'dt-mail-text'), line = el('span', 'dt-mail-line');
    line.append(el('span', `dt-mail-title${m.medium ? ' dt-mail-medium' : ''}`, m.title || '')); // medium: the title is a name (an agent), so 13/500, not a row's own title at 400 (#9758)
    if (m.starred) { const star = el('span', 'dt-star dt-star-on dt-mail-star material-icons', 'star'); star.setAttribute('aria-hidden', 'true'); line.append(star); } // a starred artifact keeps its glyph on a phone, which is a mark, not a button (#9834)
    if (showTeam && m.team) line.append(el('span', 'dt-mail-team', ` - ${m.team}`)); // who is asking: the team (with its computer when a hub has several) after the title in the tertiary colour
    { const sn = el('span', 'dt-mail-snippet', m.snippet || ''); if (m.snippetTip && m.snippet) sn.title = m.snippet; line.append(' ', sn); } // snippetTip: the whole words are the snippet's hover where the line cuts it (Needs you's ask, #9495, #9986) // a space between the words: the row reads as words, not run together
    if (m.live) { const dot = el('span', 'dt-mail-live'); dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', m.live); dot.title = m.live; line.append(dot); } // a live chat's state: a dot after the title (names stay in one column), its word the label (Active now) (#9740)
    text.append(line);
    if (m.ask) { text.classList.add('dt-mail-two'); const ask = el('span', 'dt-mail-ask', m.ask); ask.title = m.ask; text.append(ask); } // the whole ask is the line's title, so a cut one can be read (#9495)
    const side = el('span', 'dt-mail-side'); side.append(el('span', 'dt-mail-time', m.time || ''));
    if (m.mark) { const dot = el('span', `dt-mail-dot dt-mail-${m.mark}`); dot.setAttribute('aria-hidden', 'true'); side.append(dot); }
    else if (m.unread) { const dot = el('span', 'dt-mail-dot dt-mail-new'); dot.append(el('span', 'sr-only', 'Unread')); side.append(dot); } // the dot is the signal, the 600 only reinforces it, and neither is colour alone
    body.append(text, ' ', side);
    td.append(lead, body);
    if (m.answers) td.append(m.answers); // a Needs you row's choices, under the line (#10400)
    return td;
};

export function dataTable(cfg) {
    if (cfg.oneLine) cfg = { ...cfg, fold: 'none', layout: 'fixed', resize: false };
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
    box.append(sortBar, table);

    // ── column widths (#7949): a handle on each header's right edge; the widths are kept per list in this browser ──
    const MIN_W = 64, MAX_W = 2000, STEP = 16;
    const wkey = `coral-dt-widths:${cfg.widthsKey || String(cfg.label).replace(/,\s*\d.*$/, '')}`; // a label that counts its rows ("Tasks, 12") is the list "Tasks"
    const minOf = (c) => c.minWidth || MIN_W;
    const fixedW = (c) => (c.fixed && /rem$/.test(c.width || '') ? c.width : null); // a fixed column (the Actions of a list) has the width it declares: no handle, never frozen or kept, so no other column's resize squeezes its buttons (#9845)
    function readWidths() {
        try {
            const o = JSON.parse(browserLocal.get(wkey) || 'null') || {}, out = {};
            for (const c of columns) { const v = Number(o[c.key]); if (!c.fixed && Number.isFinite(v) && v >= minOf(c) && v <= MAX_W) out[c.key] = Math.round(v); } // a fixed column is never kept
            return out;
        } catch { return {}; }
    }
    function saveWidths() {
        if (Object.keys(st.widths).length) browserLocal.set(wkey, JSON.stringify(st.widths)); else browserLocal.remove(wkey); // a convenience: the store is guarded, and the widths last until the page closes without it
    }
    let emptyKeys = new Set(); // the columns no row has anything in (syncEmptyColumns, below)
    let tightKeys = new Set(); // the columns dropped because the box is narrow (syncTight, below): their <col> is hidden too, or the widths of the colgroup shift onto the wrong columns (#10443)
    st.widths ||= cfg.oneLine ? {} : readWidths();
    function applyWidths() {
        colgroup.replaceChildren();
        const any = Object.keys(st.widths).length > 0;
        box.classList.toggle('dt-sized', any);
        if (cfg.layout !== 'fixed' && !cfg.oneLine) table.style.tableLayout = any ? 'fixed' : '';
        if (!any) { table.style.width = ''; return; }
        if (sel) { const k = el('col'); k.style.width = 'var(--table-check-w)'; colgroup.append(k); }
        const shown = columns.filter(c => !emptyKeys.has(c.key) && !tightKeys.has(c.key)), all = shown.every(c => st.widths[c.key] || fixedW(c));
        const part = c => (st.widths[c.key] ? `${st.widths[c.key]}px` : fixedW(c)), checkW = sel ? ['var(--table-check-w)'] : [];
        // Every column has a width (the flexible name column's own separator was used): the table is as wide as its columns, never narrower than its box. A fixed table at 100% spreads what is left over
        // across ALL its columns, so shrinking one column grew the others (#9228); so the last column that can be resized takes what the others leave, up to the box's edge (#10443: dragging the last
        // column's right edge left ended the table short of the card, cut its words and left a scrollbar over empty space), and a column's separator changes that column alone. Wider than the box, the table scrolls.
        const fill = all ? [...shown].reverse().find(c => !c.fixed) : null;
        for (const c of columns) {
            const k = el('col');
            if (c === fill) k.style.width = `max(${part(c)}, calc(100% - (${[...checkW, ...shown.filter(x => x !== c).map(part)].join(' + ') || '0px'})))`;
            else if (st.widths[c.key]) k.style.width = `${st.widths[c.key]}px`; else if (fixedW(c)) k.style.width = fixedW(c);
            if (emptyKeys.has(c.key)) k.classList.add('dt-col-unused'); if (tightKeys.has(c.key)) k.classList.add('dt-col-tight'); colgroup.append(k);
        }
        table.style.width = all ? `max(calc(${[...checkW, ...shown.map(part)].join(' + ')}), 100%)` : '';
    }
    /** The first resize freezes the other columns at the widths they have (the title column, 'grow', takes whatever is left) so nothing jumps. */
    function freezeWidths() {
        for (const th of thead.querySelectorAll('th.dt-th')) { const c = columns.find(x => x.key === th.dataset.key); if (c && c.width !== 'grow' && !c.fixed && !st.widths[c.key]) st.widths[c.key] = Math.max(minOf(c), Math.round(th.getBoundingClientRect().width)); }
    }
    function setWidth(c, w, th) {
        st.widths[c.key] = Math.min(MAX_W, Math.max(minOf(c), Math.round(w)));
        applyWidths();
        const h = th && th.querySelector('.dt-resize'); if (h) h.setAttribute('aria-valuenow', String(st.widths[c.key]));
    }
    /** The width the column needs for its widest cell and its head: the table is laid out at its natural width for a moment (auto layout, as wide as its content, none of the kept widths) and the column's own head is measured. */
    function fitWidth(c, th) {
        const was = { layout: table.style.tableLayout, width: table.style.width, cols: colgroup.cloneNode(true) };
        colgroup.replaceChildren(); table.style.tableLayout = 'auto'; table.style.width = 'max-content'; box.classList.remove('dt-sized');
        const natural = Math.ceil(th.getBoundingClientRect().width);
        table.style.tableLayout = was.layout; table.style.width = was.width; colgroup.replaceChildren(...was.cols.childNodes); box.classList.toggle('dt-sized', Object.keys(st.widths).length > 0);
        return Math.min(800, natural);
    }
    /** Fit the column to its content: when that is the width it has, nothing changed and nothing is kept (no Reset appears for it). */
    function fitTo(c, th) {
        const w = fitWidth(c, th);
        if (Math.abs(w - Math.round(th.getBoundingClientRect().width)) <= 1) return;
        freezeWidths(); setWidth(c, w, th); saveWidths();
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
            const startX = e.clientX, start = now(); let moved = false;
            const move = (ev) => { if (!moved) { if (Math.abs(ev.clientX - startX) < 2) return; moved = true; freezeWidths(); } setWidth(c, start + (ev.clientX - startX), th); }; // a press that does not move changes nothing: no frozen widths, no Reset
            const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); h.classList.remove('dt-resizing'); if (moved) saveWidths(); };
            h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
        });
        h.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); fitTo(c, th); }); // fit the column to its content
        h.addEventListener('keydown', (e) => {
            const step = e.shiftKey ? STEP * 3 : STEP;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); freezeWidths(); setWidth(c, now() + (e.key === 'ArrowRight' ? step : -step), th); saveWidths(); }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); fitTo(c, th); }
        });
        return h;
    }

    const sortable = columns.filter(c => c.sort);
    const sortedRows = () => {
        const s = st.sort && columns.find(c => c.key === st.sort.key);
        if (!s || !s.sort || cfg.onSort) return rows;
        const cmp = compareBy(s), dir = st.sort.dir === 'desc' ? -1 : 1;
        return rows.slice().sort((a, b) => dir * cmp(a, b));
    };

    // Column sizing (#9846, design note rules 3 to 5), all optional: min and max in characters (ch follows the text size), share (the part of the leftover width a flexible column takes: Item 2, Goal 1), fixed (a column
    // that is never shrunk: Actions, its width is its minimum). The first resize still freezes the widths as before; these are the defaults a list starts from.
    const shareTotal = columns.reduce((n, c) => n + (c.share || 0), 0);
    function sizeColumn(c, node) {
        const ATTR = { min: 'data-dt-min', max: 'data-dt-max', w: 'data-dt-w' };
        const set = (name, v) => { node.style.setProperty(`--dt-${name}`, v); node.setAttribute(ATTR[name], ''); }; // custom properties, read by data_table.css only while the table is not folded: a folded (phone) row lays its cells out its own way
        if (c.min) set('min', `min(${c.min}ch, 40cqw)`); // never more than 40% of the table's box (of the screen where it is not a container): the dock's Tasks table (State, Task, Who) was wider than its box with the name at 24 characters, on a 390 px phone and at 200% text in the 680 px dock (#9917)
        if (c.max) set('max', `${c.max}ch`);
        if (c.fixed && c.width && /rem$/.test(c.width)) { set('min', c.width); set('max', 'none'); set('w', c.width); }
        if (c.share) { set('w', `${Math.round(90 * c.share / shareTotal)}%`); if (!c.max) set('max', '0'); } // a share column is bounded (max-width 0 with its min-width above it): in an auto layout its no-wrap text otherwise sets the column to the width of the text and the table scrolls sideways (UI Accessibility, #9856)
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
        for (const td of tbody.querySelectorAll(':scope > .dt-row > td.dt-td')) td.classList.toggle('dt-col-unused', emptyKeys.has(td.dataset.key));
        applyWidths();
    }

    // When the columns do not fit the box, the optional ones go by priority (#9846, rule 5): a column with `drop: n` is hidden, the lowest n first (1 goes first), until the table fits; Actions and the name never carry a drop. They return as the box grows.
    function syncTight() {
        if (mailOn() || box.classList.contains('dt-folded') || !box.clientWidth) return;
        const hide = (key, on) => { for (const n of box.querySelectorAll(`th.dt-th[data-key="${attrEsc(key)}"], td.dt-td[data-key="${attrEsc(key)}"]`)) n.classList.toggle('dt-col-tight', on); if (on) tightKeys.add(key); else tightKeys.delete(key); applyWidths(); };
        const cand = columns.filter(c => c.drop && !emptyKeys.has(c.key)).sort((a, b) => a.drop - b.drop);
        for (const c of cand) hide(c.key, false);
        for (const c of cand) { if (box.scrollWidth <= box.clientWidth + 1) break; hide(c.key, true); }
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
            if (cfg.resize !== false && c.resize !== false && !c.fixed) th.append(resizeHandle(c, th));
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
        if (c.width === 'content') td.classList.add('dt-content');
        sizeColumn(c, td);
        td.setAttribute('role', 'cell'); td.dataset.label = c.label; td.dataset.key = c.key;
        if (cfg.oneLine && c.dropAt) td.setAttribute('data-drop-at', String(c.dropAt));
        if (c.tiny) td.setAttribute('data-tiny', 'hide');
        td.classList.add(c.line === 1 ? 'dt-line-1' : c.line === 2 ? 'dt-line-2' : 'dt-line-0');
        if (c.when && !c.when(r)) td.classList.add('dt-when-off');
        if (emptyKeys.has(c.key)) td.classList.add('dt-col-unused');
        if (c.foldFirst) td.classList.add('dt-fold-first');
        if (st.sort && st.sort.key === c.key) td.classList.add('dt-fold-key'); // folded 'labeled': the figure the rows are sorted by is the one stronger line (#7738)
        if (c.narrowHide) td.classList.add('dt-narrow-hide'); // folded 'labeled': this figure follows the name, ahead of the other "label value" lines
        let v = c.cell ? c.cell(r, ctx, { open: () => (cfg.open ? cfg.open(r, tr) : undefined), hasOpen: !!cfg.open }) : (c.field != null ? r[c.field] : ''); // a cell's third argument: { open(), hasOpen } is the row's own open, for a button in the cell that opens what the row opens
        if (typeof v === 'string' && c.primary) v = primaryButton(v, `Open ${v}`);
        if (v instanceof Node) td.append(v); else td.textContent = v == null ? '' : String(v);
        if (c.title) { const t = c.title(r); if (t) td.title = t; } // the full name or id on hover
        if (c.subtitle) { const s = c.subtitle(r); if (s) { const sub = el('span', 'dt-subtitle', s); if (c.subtitleTitle) { const t = c.subtitleTitle(r); if (t) sub.title = t; } td.append(sub); } } // subtitleTitle(row): the whole line on hover when the subtitle is cut with an ellipsis
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
                const m = cfg.mail(r), showTeam = !!m.team && (m.teamAlways || dupTitles().has(m.title));
                const pick = sel && eligible(r) ? () => { const cb = tr.querySelector('.dt-check input'); if (!cb) return; if (!st.select) { st.select = true; st.mailSelect = true; syncSelectMode(); } cb.dispatchEvent(new MouseEvent('click', { bubbles: true })); } : null;
                tr.classList.add('dt-mailed'); tr.append(mailCell(m, nameOf(r), !!cfg.open, pick, showTeam));
            } else for (const c of columns) tr.append(cellOf(c, r, tr));
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
        syncTight();
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
        bar.append(el('span', 'dt-bar-count', `${n} selected`));
        const actions = sel.actions || [];
        const chosen = () => [...st.selected].map(k => st.rowCache.get(k)).filter(Boolean);
        actions.forEach((a, i) => {
            if (st.confirming >= 0) return; // while one asks, the others wait
            const action = button(`btn btn-small dt-bar-action${a.danger ? ' dt-danger' : ''}`, a.label, async () => {
                if (a.choose) { st.choices = await a.choose.options(); st.confirming = i; drawBar(); bar.querySelector(a.danger ? '.dt-bar-keep' : '.dt-bar-choice')?.focus(); return; } // an action that needs a value (a person, a priority) asks for it here
                if (a.danger) { st.confirming = i; drawBar(); bar.querySelector('.dt-bar-keep')?.focus(); return; }
                a.run(chosen(), new Set(st.selected));
            });
            action.disabled = !!a.disabled?.(chosen()); bar.append(action);
        });
        if (st.confirming >= 0) {
            const a = actions[st.confirming];
            if (a.choose) {
                const pick = el('select', 'dt-bar-choice'); pick.setAttribute('aria-label', a.choose.label);
                for (const o of st.choices || []) { const op = el('option', null, o.label); op.value = o.value; pick.append(op); }
                const text = a.choose.text ? el('input', 'dt-bar-text') : null;
                if (text) { text.type = 'text'; text.setAttribute('aria-label', a.choose.text.label); text.placeholder = a.choose.text.label; text.maxLength = a.choose.text.maxLength || 300; text.required = true; }
                const apply = button(`btn btn-small dt-bar-apply${a.danger ? ' dt-danger' : ''}`, a.danger ? a.label : 'Apply', () => { if (text && !text.value.trim()) { text.reportValidity(); return; } const v = pick.value; st.confirming = -1; st.choices = null; a.run(chosen(), new Set(st.selected), v, text?.value.trim()); });
                if (text) { apply.disabled = true; text.addEventListener('input', () => { apply.disabled = !text.value.trim(); }); }
                const ask = typeof a.confirm === 'function' ? a.confirm(n) : a.confirm || `${a.label}:`;
                const step = el('div', 'dt-bar-step');
                step.append(el('span', 'dt-bar-confirm', ask), pick); if (text) step.append(text);
                step.append(button('btn btn-small dt-bar-keep', 'Keep', () => { st.confirming = -1; st.choices = null; drawBar(); }), apply);
                bar.append(step);
            } else {
                const ask = el('span', 'dt-bar-confirm', typeof a.confirm === 'function' ? a.confirm(n) : (a.confirm || `${a.label}?`)); ask.setAttribute('role', 'alert');
                bar.append(ask, button('btn btn-small dt-bar-keep', 'Keep', () => { st.confirming = -1; drawBar(); }), button('btn btn-small dt-danger', a.label, () => { st.confirming = -1; a.run(chosen(), new Set(st.selected)); }));
            }
        }
        bar.append(button('btn btn-small dt-bar-clear', 'Clear', () => clear()));
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
                box.classList.remove('dt-folded');
                on = table.getBoundingClientRect().width > w + 1;
            }
            box.classList.toggle('dt-folded', on);
            box.classList.toggle('dt-tiny', w < 20 * root()); // a phone at large text: the columns that say tiny: true go, so the name keeps its room (20 rem is a 390 px screen at 200% text)
        };
        new ResizeObserver(() => { syncFold(); syncTight(); }).observe(box);
        if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(syncFold); // fonts already in: the observer's first call settles it before the paint; calling it now read the width of a box not yet laid out, a forced layout (#9450)
    }
    mailQuery?.addEventListener?.('change', () => { box.classList.toggle('dt-mail-on', mailOn()); drawBody(); cfg.onModeChange?.(); }); // the window crosses the phone's width: the rows are drawn again in the other form; a list whose selection exists on a phone only (selectable is decided when the spec is drawn) asks its owner to draw the table again
    return { el: box, bar, selectButton, selection: () => new Set(st.selected), clear, state: st };
}
