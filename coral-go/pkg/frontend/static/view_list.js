/* The one "view list" of the mailbox (#7785, goal #20; UI/UX's mock #7773): a column of named views with a count each, one of them current, at the left of a list: Needs you, Tasks, Goals, Saved, and the chat
 * folders (All chats, Board history, By CLI, Tags). Workflows and Jobs reuse it later. Below the phone width the same views are ONE select (44 px) at the top, so the list is never squeezed beside a column.
 * An item is a button (a view is not a link); the current one says aria-current and is marked by a bar and weight, not by colour alone; a view that is not built yet is disabled and says "soon" in words.
 * A colour dot (a tag's colour) is a hex colour only. Text is set with textContent only.
 *
 *   build({ id, label, sections, current, onPick })  -> the element (the column and the select)
 *   sections: [{ title?, items: [{ key, label, count?, alert?, dot?, icon?, soon? }] }]      onPick(key) is not called for a disabled item; a section's title is also the select's group label
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
    const nav = root.querySelector('.view-list-nav'), select = root.querySelector('.view-list-select');
    const held = nav.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    nav.replaceChildren(); select.replaceChildren();
    for (const sec of sections) {
        if (sec.title) nav.append(el('h2', 'view-list-title', sec.title));
        const group = sec.title ? document.createElement('optgroup') : select;
        if (sec.title) group.label = sec.title;
        for (const it of sec.items) {
            const b = el('button', 'view-list-item'); b.type = 'button'; b.dataset.key = it.key;
            const lab = el('span', 'view-list-label');
            const icon = folderIcon(it.icon);
            if (icon) { b.classList.add('view-list-with-icon'); lab.append(icon); }
            if (it.dot && HEX.test(it.dot)) { const d = el('i', 'view-list-dot'); d.style.setProperty('--view-list-dot', it.dot); d.setAttribute('aria-hidden', 'true'); lab.append(d); }
            lab.append(el('span', 'view-list-name', it.label));
            b.append(lab);
            b.setAttribute('aria-label', it.soon ? `${it.label}, soon` : (it.count != null ? `${it.label}, ${it.count}` : it.label)); // the name and the count are read apart ("Board history, 1"), the count once (it is not in the name's text twice)
            if (it.soon) { b.disabled = true; b.classList.add('view-list-soon'); b.append(el('span', 'view-list-count', 'soon')); }
            else if (it.count != null) b.append(el('span', it.alert && Number(it.count) > 0 ? 'view-list-count view-list-alert' : 'view-list-count', it.count)); // alert: the one count that is a red pill (Needs you), and only while it is above 0; every other count stays quiet
            if (it.key === current) { b.setAttribute('aria-current', 'true'); b.classList.add('view-list-current'); }
            nav.append(b);
            if (!it.soon) {
                const o = el('option', null, it.count != null ? `${it.label} (${it.count})` : it.label); o.value = it.key; o.selected = it.key === current;
                group.append(o);
            }
        }
        if (sec.title && group.children.length) select.append(group);
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

export function build({ id, label, sections, current, onPick }) {
    const root = el('div', 'view-list'); root.dataset.viewList = id;
    const nav = el('nav', 'view-list-nav'); nav.setAttribute('aria-label', label);
    const select = el('select', 'field view-list-select'); select.setAttribute('aria-label', label);
    root.append(nav, select);
    wireKeys(nav);
    nav.addEventListener('click', e => { const b = e.target instanceof Element && e.target.closest('.view-list-item'); if (b && !b.disabled) onPick(b.dataset.key); });
    select.addEventListener('change', () => onPick(select.value));
    draw(root, { sections, current });
    return root;
}

export function update(root, spec) { draw(root, spec); }
