/* The search, filter and sort bar the list panels share (#4744), taken from Team Artifacts' (#4573): a search box with the count beside it, a Filters button that opens a menu, a Sort select and the chips of
 * the filters that are on. It is built once and kept in its panel (the panel's list is rebuilt on every change, which would take the keyboard focus out of a search box typed into), and told what to show with
 * set(). The server does the work: the bar only collects what to ask for. Each panel gives a spec (its fields, sorts and words) and a model (its filters: EMPTY, clean, chips, isFiltered, without; the panel's
 * own *_filters.js, which is pure). The classes are list-bar-* (agentic.css, touch.css); the ids come from the spec so two bars never share one. */

import { browserLocal } from './safe_storage.js';
import { importOnce } from './import_once.js';
import { isPhoneLayout } from './phone_layout.js';

const DEBOUNCE_MS = 300;
const LIVE_SETTLE_MS = 500; // how long the count must stay as it is before it is announced

/** Whether a collapsible bar's panel was left open for this list (scope: the panel, key: the board or agent), kept in this browser like the filters. */
export function loadPanelOpen(scope, key) { return !!key && browserLocal.get(`coral-list-bar-open:${scope}:${key}`) === '1'; }
export function savePanelOpen(scope, key, open) {
    if (!key) return;
    if (open) browserLocal.set(`coral-list-bar-open:${scope}:${key}`, '1'); else browserLocal.remove(`coral-list-bar-open:${scope}:${key}`);
}

function make(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
}

/** The More icon of a toolbar (#7686): three dots after the filter icon, and a menu of the list's other actions (Copy publishing instructions, Jump to first message): one control in one place on every tab. items: [{ label, run() }]. */
export function buildMoreMenu(id, items, noun = '') {
    const name = noun ? `More ${noun} actions` : 'More actions'; // the tab's own noun (UI/UX, #7717): "More message actions", "More artifact actions"; the page's header keeps its plain "More"
    const wrap = make('span', 'list-bar-more');
    const btn = make('button', 'sidebar-collapse-btn list-bar-more-btn'); btn.type = 'button'; btn.id = `${id}-more`;
    // named "More actions", not "More": a page's header has a More button too, and the team page's Board tab shows both at 390 px (#7713)
    btn.title = name; btn.setAttribute('aria-label', name); btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', `${id}-more-menu`);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of [['width', '18'], ['height', '18'], ['viewBox', '0 0 24 24'], ['fill', 'currentColor'], ['aria-hidden', 'true']]) svg.setAttribute(k, v);
    for (const x of [5, 12, 19]) { const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); c.setAttribute('cx', String(x)); c.setAttribute('cy', '12'); c.setAttribute('r', '1.8'); svg.append(c); }
    btn.append(svg);
    const menu = make('div', 'team-more-menu list-bar-more-menu'); menu.id = `${id}-more-menu`; menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', name);
    for (const it of items) {
        const b = make('button', null, it.label); b.type = 'button'; b.setAttribute('role', 'menuitem');
        b.addEventListener('click', async () => { (await importOnce('./menu_button.js')).closeMenus(); it.run(); });
        menu.append(b);
    }
    btn.addEventListener('click', async () => (await importOnce('./menu_button.js')).toggleMenu(btn)); // the menu's keyboard and outside-click handling load with the first use
    wrap.append(btn, menu);
    return wrap;
}

function selectField(id, label, values, labels, anyLabel) {
    const wrap = make('label', 'list-bar-field');
    wrap.append(make('span', 'list-bar-field-label', label));
    const s = make('select', 'list-bar-select'); s.id = id;
    if (anyLabel) s.append(new Option(anyLabel, ''));
    for (const v of values) s.append(new Option(labels[v], v));
    wrap.append(s);
    return { wrap, input: s };
}

/** One control of the Filters menu, by the field's type: select, text (with an optional datalist of names), check, date. Returns its label wrapper, its input and the filter key it edits. */
function buildField(spec) {
    if (spec.type === 'select') return { ...selectField(spec.id, spec.label, spec.values, spec.labels, spec.any), spec };
    if (spec.type === 'text') {
        const wrap = make('label', 'list-bar-field'); wrap.append(make('span', 'list-bar-field-label', spec.label));
        const input = make('input', spec.className); input.type = 'text'; input.id = spec.id; input.maxLength = spec.max; input.placeholder = spec.placeholder; input.autocomplete = 'off';
        let list = null;
        if (spec.datalist) {
            input.setAttribute('l' + 'ist', spec.datalist); /* the attribute that links a datalist, spelled in two parts: the icon-name lint reads that quoted word as an icon name */
            list = make('datalist'); list.id = spec.datalist;
        }
        wrap.append(input); if (list) wrap.append(list);
        return { wrap, input, list, spec };
    }
    if (spec.type === 'check') {
        const wrap = make('label', spec.wrapClass); const input = make('input'); input.type = 'checkbox'; input.id = spec.id;
        wrap.append(input, make('span', 'list-bar-field-label', spec.label));
        return { wrap, input, spec };
    }
    const wrap = make('label', 'list-bar-field'); wrap.append(make('span', 'list-bar-field-label', spec.label));
    const input = make('input'); input.type = 'date'; input.id = spec.id; wrap.append(input);
    return { wrap, input, spec };
}

/** onChange(filters) is called with the new, clean filters when the person changes anything (typing after a short pause). */
export function buildListBar(spec, onChange, hooks = {}) {
    const { EMPTY, clean, chips, isFiltered, without } = spec.model;
    const p = spec.idp;
    let f = { ...EMPTY };
    let timer = 0;
    const node = make('div', 'list-bar-bar');
    node.setAttribute('role', 'search'); node.setAttribute('aria-label', spec.label);

    // A panel that has a search box of its own (the agent list's) gives spec.noSearch: the bar then has the filters, the sort, the count and the chips, and no search row (its q is not the bar's).
    const noSearch = !!spec.noSearch;
    // spec.inline (the agent list's, #4947): the fields and the sort sit open in the panel that holds the bar (the Display expander), not behind a Filters button; the chips give way to the panel owner's summary line.
    const inline = !!spec.inline;
    // spec.collapsible (#5293, the agent list's pattern): the Filters button and the Sort row give way to one icon on the search row, with the count beside it; it opens a panel under the row that holds the
    // fields, the sort and Clear filters, and the chips of what is on stay under the row when it is shut. spec.expandAll adds the second icon (the list's expand or collapse all), told by hooks.onExpandAll.
    const collapsible = !!spec.collapsible && !spec.noSearch && !inline;
    const searchRow = make('div', 'list-bar-search-row');
    const wrap = make('div', 'list-bar-search-wrap');
    const q = make('input', 'list-bar-search'); q.type = 'search'; q.id = `${p}-search`; q.placeholder = spec.placeholder; q.maxLength = 200; q.autocomplete = 'off'; q.spellcheck = false;
    q.setAttribute('aria-label', spec.searchLabel);
    const clearQ = make('button', 'list-bar-clear-q', '×'); clearQ.type = 'button'; clearQ.setAttribute('aria-label', 'Clear search'); clearQ.hidden = true;
    wrap.append(q, clearQ);
    const count = make('span', 'list-bar-count'); count.hidden = !!spec.hideCount; // keep settled search announcements without a visible toolbar count
    // The count is not a live region itself: a list that changes under the person (agents coming and going, a poll) would have a screen reader announce it again and again. A hidden status region says it
    // only after the person changed the search or a filter (apply), which is when they want to hear how many are left.
    const live = make('span', 'list-bar-live'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    let announce = false;
    let liveTimer = 0; // the announcement waits for the count to settle: a server-backed panel draws the old count first and the answer's a moment later
    let tog = null, badge = null, chev = null;
    // the icon and the panel are named for what the panel holds (#8251): "Filters and sort" where it has a Sort, "Filters" where it has not
    const panelName = spec.sorts ? 'Filters and sort' : 'Filters';
    if (collapsible) {
        tog = make('button', 'sidebar-collapse-btn list-bar-toggle'); tog.type = 'button'; tog.id = `${p}-toggle`;
        tog.setAttribute('aria-expanded', 'false'); tog.setAttribute('aria-controls', `${p}-menu`); tog.title = panelName; tog.setAttribute('aria-label', panelName);
        const icon = make('span', 'material-icons', 'notes'); icon.setAttribute('aria-hidden', 'true');
        badge = make('span', 'display-badge'); badge.hidden = true;
        tog.append(icon, badge);
        if (spec.expandAll) {
            chev = make('button', 'sidebar-collapse-btn group-toggle-btn list-bar-expand-all'); chev.type = 'button'; chev.dataset.next = 'expand';
            chev.innerHTML = '<svg class="group-toggle-collapse" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9l5-5 5 5M7 15l5 5 5-5"/></svg><svg class="group-toggle-expand" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4l5 5 5-5M7 20l5-5 5 5"/></svg>';
            chev.title = spec.expandAll.expand; chev.setAttribute('aria-label', spec.expandAll.expand);
        }
    }
    // spec.headerSlots (#5315): the owner's title goes before the search box and its action icons after the filter icon, on this one row (setHeader). The slots are display: contents, so their children are the row's own.
    const lead = spec.headerSlots ? make('span', 'list-bar-lead') : null, tail = spec.headerSlots ? make('span', 'list-bar-tail') : null;
    // spec.more (#7686): the list's other actions behind one More icon after the filter icon and the owner's own icons.
    const more = spec.more && spec.more.length && !noSearch ? buildMoreMenu(p, spec.more, spec.moreNoun || '') : null;
    if (noSearch) searchRow.hidden = true; else searchRow.append(...(lead ? [lead] : []), wrap, count, ...(tog ? [tog] : []), ...(chev ? [chev] : []), ...(tail ? [tail] : []), ...(more ? [more] : []));

    const controls = make('div', 'list-bar-controls');
    const filterBtn = make('button', 'list-bar-filter-btn', 'Filters'); filterBtn.type = 'button';
    filterBtn.setAttribute('aria-haspopup', 'true'); filterBtn.setAttribute('aria-expanded', 'false'); filterBtn.setAttribute('aria-controls', `${p}-menu`);
    // A panel with one fixed order (the board's messages: the page is the order) has no sort: spec.sorts is null.
    const sort = spec.sorts ? selectField(`${p}-sort`, 'Sort', spec.sorts.values, spec.sorts.labels) : null;
    if (sort) { sort.wrap.classList.add('list-bar-sort'); sort.input.setAttribute('aria-label', spec.sorts.aria); }
    // A panel with only a search (no fields: the Servers list) has no Filters button and no menu.
    const hasFilters = spec.fields.length > 0;
    if (inline) { if (sort) sort.wrap.classList.remove('list-bar-sort'); }
    else if (collapsible) { if (sort) sort.wrap.classList.remove('list-bar-sort'); }
    else controls.append(...[hasFilters ? filterBtn : null, sort ? sort.wrap : null].filter(Boolean));
    if (noSearch && !inline) controls.append(count);

    const menu = make('div', 'list-bar-menu'); menu.id = `${p}-menu`; menu.hidden = true; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', 'Filters');
    const fields = spec.fields.map(buildField);
    const clearAll = make('button', 'list-bar-clear-all', 'Clear all'); clearAll.type = 'button';
    // spec.doneButton (#7883): a phone's panel has a Done button that shuts it (the filters apply as they are chosen, so there is nothing to confirm); a desktop's panel stays beside the list and has no use for it
    const done = collapsible && spec.doneButton ? make('button', 'list-bar-done btn', 'Done') : null;
    if (done) done.type = 'button';
    // extras (#7924): controls the panel's owner keeps (the dock's Hide done: a preference of its own, not a filter of the query) go in the panel after the fields and the sort, and count toward the icon's badge (setExtraOn)
    const extras = make('div', 'list-bar-extras'); extras.hidden = true;
    menu.append(...fields.map(x => x.wrap), ...((inline || collapsible) && sort ? [sort.wrap] : []), ...(inline ? [count] : []), extras, clearAll, ...(done ? [done] : []));
    if (inline) { menu.hidden = false; menu.classList.add('list-bar-menu-inline'); clearAll.textContent = 'Clear filters'; }
    if (collapsible) { menu.classList.add('list-bar-menu-inline', 'list-bar-panel'); clearAll.textContent = 'Clear filters'; menu.setAttribute('aria-label', panelName); }
    // A panel with tool-group boxes (the activity bars) lays them out two to a line: a class on the menu, not a :has() rule, which made every DOM change in the page, the agent list's included, check for it (#7671).
    if (collapsible && fields.some(x => x.wrap.classList.contains('list-bar-group'))) menu.classList.add('list-bar-menu-groups');
    // spec.compactPanel (#7782): the fields sit two to a line (one on a phone) instead of one tall row each, so the panel does not push the list down by a row per field
    if (collapsible && spec.compactPanel) menu.classList.add('list-bar-menu-grid');
    // spec.sheet (#8681): on a phone the panel is a sheet over the list (not in the flow); a tap outside it shuts it, like Escape and Done. Not modal: no focus trap, the page keeps its scroll.
    if (collapsible && spec.sheet) menu.classList.add('list-bar-sheet');

    const chipList = make('ul', 'list-bar-chips'); chipList.setAttribute('aria-label', 'Active filters'); chipList.hidden = true;
    if (noSearch) node.classList.add('list-bar-nosearch');
    node.append(...(noSearch ? [] : [searchRow]), ...(controls.children.length ? [controls] : []), ...(hasFilters ? [menu] : []), ...(inline ? [] : [chipList]), live);
    if (collapsible) node.classList.add('list-bar-collapsible');
    if (lead) node.classList.add('list-bar-has-header');

    // Whatever a panel's model does with a text, the bar sends it trimmed: a tab or a space pasted at either end is a request the server refuses (#4806), and no panel can forget it.
    const textKeys = ['q', ...spec.fields.filter(x => x.type === 'text').map(x => x.key)];
    const trimmed = o => { const t = { ...o }; for (const k of textKeys) if (typeof t[k] === 'string') t[k] = t[k].trim(); return t; };
    let baseOn = 0, extraOn = 0;
    function paintBadge() {
        if (!tog) return;
        const on = baseOn + extraOn;
        badge.hidden = on === 0; tog.classList.toggle('active', on > 0);
        const name = on ? `${panelName}, ${on} on` : panelName;
        tog.setAttribute('aria-label', name); tog.title = name;
    }
    const apply = next => { f = clean(trimmed(next)); announce = true; onChange({ ...f }); };
    const later = next => { clearTimeout(timer); timer = setTimeout(() => apply(next), DEBOUNCE_MS); };
    // the first field that is drawn: a hidden one (the Inbox's Server field with one computer, showField) takes no focus, and the panel would open with the focus on the page (#8812)
    const focusFirstField = () => (fields.find(x => !x.wrap.hidden) || fields[0])?.input.focus();
    // the panel of a collapsible bar: opened and shut by the icon (the state is the panel's owner's to keep: hooks.onPanel)
    const setOpen = (open, { focus = false, silent = true } = {}) => {
        if (!tog) return;
        menu.hidden = !open; tog.setAttribute('aria-expanded', String(open));
        // a sheet sits under the search row (in a flex bar an absolute box would start at the bar's top, over the search row): its top is the row's bottom; no effect where the panel is in the flow
        if (open && spec.sheet) menu.style.top = `${searchRow.offsetTop + searchRow.offsetHeight + 4}px`;
        if (!silent && hooks.onPanel) hooks.onPanel(open);
        if (open && focus) focusFirstField();
    };
    const closeMenu = (focus) => { if (tog) { if (!menu.hidden) { setOpen(false, { silent: false }); if (focus) tog.focus(); } return; } if (inline || menu.hidden) return; menu.hidden = true; filterBtn.setAttribute('aria-expanded', 'false'); if (focus) filterBtn.focus(); };

    if (!noSearch) {
        q.addEventListener('input', () => { clearQ.hidden = !q.value; later({ ...f, q: q.value }); });
        q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); apply({ ...f, q: q.value }); } });
        clearQ.addEventListener('click', () => { clearTimeout(timer); q.value = ''; clearQ.hidden = true; apply({ ...f, q: '' }); q.focus(); });
    }
    if (tog) tog.addEventListener('click', () => setOpen(menu.hidden, { focus: true, silent: false }));
    if (done) done.addEventListener('click', () => { setOpen(false, { silent: false }); tog.focus(); });
    if (chev) chev.addEventListener('click', () => { const next = chev.dataset.next; if (hooks.onExpandAll) hooks.onExpandAll(next); });
    filterBtn.addEventListener('click', () => {
        const open = menu.hidden;
        menu.hidden = !open; filterBtn.setAttribute('aria-expanded', String(open));
        if (open) focusFirstField();
    });
    node.addEventListener('keydown', e => { if (e.key === 'Escape' && !inline && !menu.hidden && !(tog && !menu.contains(e.target))) { e.preventDefault(); e.stopPropagation(); closeMenu(true); } });
    const outside = e => { if (!inline && (!tog || (spec.sheet && isPhoneLayout())) && !menu.hidden && !node.contains(e.target)) closeMenu(false); }; // a collapsible panel is in the flow: it stays open until the icon shuts it (a phone's sheet shuts on a tap outside too)
    document.addEventListener('click', outside);
    for (const fld of fields) {
        const key = fld.spec.key;
        if (fld.spec.type === 'text') fld.input.addEventListener('input', () => later({ ...f, [key]: fld.input.value }));
        else if (fld.spec.type === 'check') fld.input.addEventListener('change', () => apply({ ...f, [key]: fld.input.checked }));
        else fld.input.addEventListener('change', () => apply({ ...f, [key]: fld.input.value }));
    }
    if (sort) sort.input.addEventListener('change', () => apply({ ...f, sort: sort.input.value }));
    const everything = () => { clearTimeout(timer); apply({ ...EMPTY, sort: f.sort }); };
    const focusSearch = () => { if (!noSearch) q.focus(); else if (inline) fields[0]?.input.focus(); else filterBtn.focus(); };
    clearAll.addEventListener('click', () => { everything(); focusSearch(); });

    return {
        node,
        /** The row of the Filters button (and Sort): a panel puts its own buttons beside them. */
        controls,
        /** Show these filters and counts ({shown, matched, all}); a field the person is typing in is left as typed. */
        set(next, counts) {
            f = clean(next);
            const put = (el, v) => { if (el.value !== v && document.activeElement !== el) el.value = v; };
            if (!noSearch) { put(q, f.q); clearQ.hidden = !q.value; }
            for (const fld of fields) {
                const key = fld.spec.key;
                if (fld.spec.type === 'text') put(fld.input, f[key]);
                else if (fld.spec.type === 'check') fld.input.checked = f[key];
                else fld.input.value = f[key];
            }
            if (sort) sort.input.value = f.sort;
            const list = chips(f);
            chipList.replaceChildren(...list.map(c => {
                const li = make('li'); const b = make('button', 'list-bar-chip'); b.type = 'button';
                b.append(make('span', 'list-bar-chip-text', c.label), make('span', 'list-bar-chip-x', '×'));
                b.setAttribute('aria-label', `Remove filter: ${c.label}`);
                b.addEventListener('click', () => { clearTimeout(timer); apply(without(f, c.key)); focusSearch(); });
                li.append(b); return li;
            }));
            if (list.length > 1) { const li = make('li'); const b = make('button', 'list-bar-chip list-bar-chip-all', 'Clear all'); b.type = 'button'; b.addEventListener('click', () => { everything(); focusSearch(); }); li.append(b); chipList.append(li); }
            chipList.hidden = !list.length || !!spec.chipsElsewhere; // spec.chipsElsewhere (#7782): the owner shows the chips itself (the team Tasks tab: on the toolbar line)
            if (inline || collapsible) clearAll.hidden = !isFiltered(f);
            filterBtn.textContent = isFiltered(f) ? `Filters (${list.filter(c => c.key !== 'q').length})` : 'Filters';
            if (tog) {
                // what is on behind the icon: the filters (the search is its own box) and a sort that is not the default; the icon says so, so a shut panel never hides a filter
                baseOn = list.filter(c => c.key !== 'q').length + (f.sort !== EMPTY.sort ? 1 : 0);
                paintBadge();
            }
            const all = `${counts && counts.all}${counts && counts.truncated ? '+' : ''}`; // '+': older ones were not scanned
            const say = text => {
                count.textContent = text;
                if (!announce || !text) return; // an empty text (no counts yet) is not a count to say
                clearTimeout(liveTimer);
                liveTimer = setTimeout(() => { if (!count.textContent) return; /* no count to say yet (the answer is slower than the settle): keep the flag for it */ announce = false; live.textContent = count.textContent; }, LIVE_SETTLE_MS);
            };
            if (counts && counts.text != null) { say(counts.text); return; } // a panel that words its own count (the agent list's: its search text narrows it too)
            say(!counts ? '' : isFiltered(f) ? `${counts.matched} of ${all}` : `${all} ${counts.all === 1 && !counts.truncated ? spec.noun : (spec.plural || spec.noun + 's')}`);
        },
        /** The names seen in the list, offered in the text field that has a datalist (typed text still works). */
        names(list) { const fld = fields.find(x => x.list); if (fld) fld.list.replaceChildren(...list.map(n => new Option(n))); },
        /** A select field's options, when they change with the list (the boards or machines there are now): the value is kept if it is still one of them. */
        setOptions(key, values, labels, groups = null) {
            const fld = fields.find(x => x.spec.key === key); if (!fld || fld.spec.type !== 'select') return;
            const cur = fld.input.value;
            const any = fld.spec.any ? [new Option(fld.spec.any, '')] : [];
            // groups ({ value: group label }, #7782): a value in a group is listed under that label (the Goal field: open goals, then the closed ones), in the order the values come; a value with no group stays at the top
            const made = [], byLabel = new Map();
            for (const v of values) {
                const o = new Option(labels[v] || v, v), g = groups && groups[v];
                if (!g) { made.push(o); continue; }
                if (!byLabel.has(g)) { const og = document.createElement('optgroup'); og.label = g; byLabel.set(g, og); made.push(og); }
                byLabel.get(g).append(o);
            }
            fld.input.replaceChildren(...any, ...made);
            fld.input.value = values.includes(cur) ? cur : '';
        },
        /** Show or hide a field of the Filters menu (the Machine field, where there is only one machine). */
        showField(key, visible) { const fld = fields.find(x => x.spec.key === key); if (fld) fld.wrap.hidden = !visible; },
        closeMenu,
        focusSearch,
        /** A collapsible bar: show or hide the panel (the owner restores what it kept; this does not call hooks.onPanel). */
        setOpen,
        isOpen: () => !menu.hidden,
        /** The expand-all icon: what pressing it will do next ('expand' or 'collapse'). */
        setExpandNext(next) { if (!chev) return; chev.dataset.next = next; const word = spec.expandAll[next]; chev.title = word; chev.setAttribute('aria-label', word); },
        /** The owner's own controls in the panel (nodes), and how many of them are on: the icon's badge counts them with the filters. */
        setExtras(nodes) { extras.replaceChildren(...nodes); extras.hidden = !nodes.length; },
        setExtraOn(n) { if (n !== extraOn) { extraOn = n; paintBadge(); } },
        /** A bar with headerSlots: the title (a node) before the search box, and the action icons (nodes) after the filter icons. */
        setHeader(title, tools = []) { if (!lead) return; lead.replaceChildren(...(title ? [title] : [])); tail.replaceChildren(...tools); },
        /** A bar that is replaced (a panel rebuilt for another board) lets go of the page's click listener and any search still waiting. */
        dispose() { document.removeEventListener('click', outside); clearTimeout(timer); clearTimeout(liveTimer); node.remove(); },
    };
}
