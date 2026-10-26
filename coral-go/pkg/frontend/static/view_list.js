/* The one "view list" of the mailbox (#7785, goal #20; UI/UX's mock #7773): a column of named views with a count each, one of them current, at the left of a list: Needs you, Tasks, Goals, Saved, and the chat
 * folders (All chats, Group chats, By CLI, Tags). Workflows and Jobs reuse it later. Below the phone width the same views are ONE select (44 px) at the top, so the list is never squeezed beside a column.
 * An item is a button (a view is not a link); the current one says aria-current and is marked by a bar and weight, not by colour alone; a view that is not built yet is disabled and says "soon" in words.
 * A colour dot (a tag's colour) is a hex colour only. Text is set with textContent only.
 *
 *   build({ id, label, sections, current, onPick })  -> the element (the column and the select)
 *   sections: [{ title?, items: [{ key, label, count?, alert?, dot?, soon? }] }]      onPick(key) is not called for a disabled item; a section's title is also the select's group label
 *   update(root, { sections, current })               -> draws the same element again with new counts or another current view; the keyboard stays on the item it was on */
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
const HEX = /^#[0-9a-f]{3,8}$/i;

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
            if (it.dot && HEX.test(it.dot)) { const d = el('i', 'view-list-dot'); d.style.setProperty('--view-list-dot', it.dot); d.setAttribute('aria-hidden', 'true'); lab.append(d); }
            lab.append(el('span', 'view-list-name', it.label));
            b.append(lab);
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
    if (held) [...nav.querySelectorAll('.view-list-item')].find(b => b.dataset.key === held && !b.disabled)?.focus({ preventScroll: true });
}

export function build({ id, label, sections, current, onPick }) {
    const root = el('div', 'view-list'); root.dataset.viewList = id;
    const nav = el('nav', 'view-list-nav'); nav.setAttribute('aria-label', label);
    const select = el('select', 'view-list-select'); select.setAttribute('aria-label', label);
    root.append(nav, select);
    nav.addEventListener('click', e => { const b = e.target instanceof Element && e.target.closest('.view-list-item'); if (b && !b.disabled) onPick(b.dataset.key); });
    select.addEventListener('change', () => onPick(select.value));
    draw(root, { sections, current });
    return root;
}

export function update(root, spec) { draw(root, spec); }
