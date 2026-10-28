/* The one "view list" of the mailbox (#7785, goal #20; UI/UX's mock #7773): a column of named views with a count each, one of them current, at the left of a list: Needs you, Tasks, Goals, Saved, and the chat
 * folders (All chats, Board history, By CLI, Tags). Workflows and Jobs reuse it later. Below the phone width the same views are ONE select (44 px) at the top, so the list is never squeezed beside a column.
 * An item is a button (a view is not a link); the current one says aria-current and is marked by a bar and weight, not by colour alone; a view that is not built yet is disabled and says "soon" in words.
 * A colour dot (a tag's colour) is a hex colour only. Text is set with textContent only.
 *
 *   build({ id, label, sections, current, onPick, drawer })  -> the element (the column and the select; with `drawer`, the column and, on a phone, a drawer opened by a button that names the current view, in place of the select: the Inbox's, #9545)
 *   sections: [{ title?, items: [{ key, label, count?, unread?, total?, alert?, dot?, icon?, soon? }] }]      unread: the number is the unread count (its name says "3 unread", its tooltip "N in all" from total)      onPick(key) is not called for a disabled item; a section's title is also the select's group label
 *   update(root, { sections, current })               -> draws the same element again with new counts or another current view; the keyboard stays on the item it was on */
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
const HEX = /^#[0-9a-f]{3,8}$/i;

/** Existing folder glyphs and the shared provider mark; decoration never contributes to the button's accessible name. */
function folderIcon(name) {
    if (!name) return null;
    const icon = el('span', 'view-list-icon top-bar-icon'); icon.dataset.icon = name; icon.setAttribute('aria-hidden', 'true');
    if (name.startsWith('cli:')) {
        icon.classList.add('agent-type-mark'); icon.dataset.agentType = name.slice(4);
    } else if (name === 'saved-bookmark') {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M4 2.5h8v11L8 10.5l-4 3z'); svg.append(path); icon.append(svg); // the top bar's Saved bookmark
    } else { icon.classList.add('material-icons'); icon.textContent = name; }
    return icon;
}

function draw(root, { sections, current }) {
    const nav = root.querySelector('.view-list-nav'), select = root.querySelector('.view-list-select'), trigger = root.querySelector('.view-list-trigger');
    const held = nav.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    nav.replaceChildren(); select?.replaceChildren();
    for (const sec of sections) {
        if (sec.title) nav.append(el('h2', 'group-head view-list-title', sec.title));
        const group = select ? (sec.title ? document.createElement('optgroup') : select) : null;
        if (group && sec.title) group.label = sec.title;
        for (const it of sec.items) {
            const b = el('button', 'view-list-item list-row'); b.type = 'button'; b.dataset.key = it.key;
            const lab = el('span', 'view-list-label');
            const icon = folderIcon(it.icon);
            if (icon) { b.classList.add('view-list-with-icon'); lab.append(icon); }
            if (it.dot && HEX.test(it.dot)) { const d = el('i', 'view-list-dot'); d.style.setProperty('--view-list-dot', it.dot); d.setAttribute('aria-hidden', 'true'); lab.append(d); }
            lab.append(el('span', 'view-list-name', it.label));
            b.append(lab);
            const total = it.unread && it.count == null && it.total != null ? it.total : null; // a chat folder with nothing unread says how many it holds, as the other folders do (#10319): the unread number, when there is one, is the pill
            b.setAttribute('aria-label', it.soon ? `${it.label}, soon` : total != null ? `${it.label}, ${total}` : (it.count != null ? `${it.label}, ${it.count}${it.unread ? ' unread' : ''}` : it.label)); // a number that is the unread count says so
            if (it.tip) b.title = it.tip; // what is behind the row, in one line (#10074)
            if (it.unread && it.total != null) b.title = `${it.total} in all`; // the name and the count are read apart ("Board history, 1"), the count once (it is not in the name's text twice)
            if (it.soon) { b.disabled = true; b.classList.add('view-list-soon'); b.append(el('span', 'view-list-count', 'soon')); }
            else if (total != null) b.append(el('span', 'view-list-count', total));
            else if (it.count != null) b.append(el('span', it.alert && Number(it.count) > 0 ? 'view-list-count view-list-alert' : it.unread ? 'view-list-count view-list-new' : 'view-list-count', it.count)); // alert: the one count that is a red pill (Needs you), and only while it is above 0; every other count stays quiet
            if (it.key === current) { b.setAttribute('aria-current', 'true'); b.classList.add('view-list-current', 'list-row-current'); }
            nav.append(b);
            if (it.key === current && trigger) { // the drawer's button: what is open, and how many
                const chevron = el('span', 'material-icons view-list-trigger-icon', 'expand_more'); chevron.setAttribute('aria-hidden', 'true'); // a chevron after the name (it opens a list), not a hamburger
                const lead = folderIcon(it.icon); if (lead) lead.classList.add('view-list-trigger-lead'); // the open folder's own icon in front: the button is the list's switcher, not a page title (#9999)
                trigger.replaceChildren(...(lead ? [lead] : []), el('span', 'view-list-trigger-name', it.label));
                if (it.count != null) trigger.append(el('span', it.alert && Number(it.count) > 0 ? 'view-list-count view-list-alert' : 'view-list-count', it.count));
                trigger.append(chevron);
                trigger.setAttribute('aria-label', `${it.label}${it.count != null ? `, ${it.count}` : ''}. Open the folders`);
            }
            if (!it.soon && group) {
                const o = el('option', null, it.count != null ? `${it.label} (${it.count})` : it.label); o.value = it.key; o.selected = it.key === current;
                group.append(o);
            }
        }
        if (group && sec.title && group.children.length) select.append(group);
    }
    // One Tab stop for the whole column (about fifteen views and tags): the item the keyboard is on, else the current view; Up, Down, Home and End move between the views (Enter and Space choose, as for any button).
    const items = [...nav.querySelectorAll('.view-list-item')].filter(b => !b.disabled);
    const stop = items.find(b => b.dataset.key === held) || items.find(b => b.getAttribute('aria-current') === 'true') || items[0];
    for (const b of nav.querySelectorAll('.view-list-item')) b.tabIndex = b === stop ? 0 : -1;
    if (held) stop?.focus({ preventScroll: true });
}

function wireKeys(nav) {
    nav.addEventListener('keydown', e => {
        const b = e.target instanceof Element && e.target.closest('.view-list-item');
        if (!b || e.altKey || e.ctrlKey || e.metaKey) return;
        const items = [...nav.querySelectorAll('.view-list-item')].filter(x => !x.disabled), i = items.indexOf(b);
        const to = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : e.key === 'ArrowUp' ? Math.max(0, i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
        if (to < 0) return;
        e.preventDefault();
        for (const x of items) x.tabIndex = x === items[to] ? 0 : -1;
        items[to].focus();
    });
}

/** The drawer (a phone's, with `drawer`): a button that names the current view opens the column as a panel over the page, 86 percent of the width, a scrim behind it; a view, the scrim and Escape close it, and the focus goes back to the button; Tab stays inside the open panel. */
function wireDrawer(root, nav) {
    const trigger = el('button', 'view-list-trigger'); trigger.type = 'button'; trigger.setAttribute('aria-expanded', 'false');
    const scrim = el('div', 'view-list-scrim'); scrim.setAttribute('aria-hidden', 'true');
    nav.id = `${root.dataset.viewList}-drawer`; trigger.setAttribute('aria-controls', nav.id);
    const open = () => { root.classList.add('view-list-open'); trigger.setAttribute('aria-expanded', 'true'); (nav.querySelector('.view-list-item[tabindex="0"]') || nav.querySelector('.view-list-item'))?.focus(); };
    const close = ({ refocus = true } = {}) => {
        if (!root.classList.contains('view-list-open')) return;
        const inside = nav.contains(document.activeElement);
        root.classList.remove('view-list-open'); trigger.setAttribute('aria-expanded', 'false');
        if (refocus && inside) trigger.focus({ preventScroll: true });
    };
    trigger.addEventListener('click', () => (root.classList.contains('view-list-open') ? close() : open()));
    scrim.addEventListener('click', () => close());
    root.addEventListener('keydown', e => {
        if (!root.classList.contains('view-list-open')) return;
        if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
        if (e.key !== 'Tab') return;
        const stops = [...nav.querySelectorAll('.view-list-item:not(:disabled)')].filter(b => b.tabIndex >= 0); // the open drawer is a modal panel over the page: Tab goes round its own stops and never into the page behind the scrim
        if (!stops.length) return;
        const first = stops[0], last = stops[stops.length - 1], at = document.activeElement;
        if (e.shiftKey && (at === first || !nav.contains(at))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (at === last || !nav.contains(at))) { e.preventDefault(); first.focus(); }
    });
    root.prepend(trigger); root.append(scrim);
    return close;
}

export function build({ id, label, sections, current, onPick, drawer = false }) {
    const root = el('div', drawer ? 'view-list view-list-drawer' : 'view-list'); root.dataset.viewList = id;
    const nav = el('nav', 'view-list-nav'); nav.setAttribute('aria-label', label);
    const select = drawer ? null : el('select', 'field view-list-select'); if (select) select.setAttribute('aria-label', label);
    root.append(nav); if (select) root.append(select);
    const hint = el('p', 'sr-only', 'Use the arrow keys to move between the views, Home and End for the first and last.'); hint.id = `view-list-hint-${id}`; // the list is one Tab stop: a screen reader says how it moves (#10420)
    nav.setAttribute('aria-describedby', hint.id); root.append(hint);
    const closeDrawer = drawer ? wireDrawer(root, nav) : () => {};
    wireKeys(nav);
    // a picked view hides with the panel: the focus goes back to the button, not to the page's top
    nav.addEventListener('click', e => { const b = e.target instanceof Element && e.target.closest('.view-list-item'); if (b && !b.disabled) { closeDrawer(); onPick(b.dataset.key); } });
    select?.addEventListener('change', () => onPick(select.value));
    draw(root, { sections, current });
    return root;
}

export function update(root, spec) { draw(root, spec); }
