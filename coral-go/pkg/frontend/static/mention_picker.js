/* The @ mention picker of the board composer (#7549, the dock chat's picker, as a combobox): typing "@" (at the start or after a space) opens a list of the team's agents, filtered by what follows, with "@all" first
 * (Notify all agents). Arrow keys move through it, Enter or Tab picks, Escape closes it; while it is closed Enter still sends (the composer's own key handler). The box is a combobox: aria-expanded, aria-controls the
 * listbox, aria-activedescendant the highlighted option. Rows are 44 px on a touch screen. Built with the DOM and textContent: names are written by agents.
 *   attachMentionPicker(input, names)  names() -> the members' names (job title, else id); attached once per box. */
const ALL = 'all';
let seq = 0;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The "@query" the cursor is at the end of (at the start of the text or after a space), or null. */
export function mentionQuery(text, cursor) {
    const m = /(^|\s)@([\w-]*)$/.exec(text.slice(0, cursor));
    return m ? { query: m[2], at: cursor - m[2].length - 1 } : null;
}

/** The names the list offers for a query: "all" first, then the members whose name holds the query (a name that starts with it first). */
export function mentionChoices(query, names) {
    const q = query.toLowerCase();
    const members = [...new Set((names || []).filter(n => typeof n === 'string' && n))].filter(n => n.toLowerCase().includes(q))
        .sort((a, b) => (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q)));
    return [...(ALL.includes(q) ? [ALL] : []), ...members];
}

export function attachMentionPicker(input, names) {
    if (!input || input.dataset.mentionPicker) return;
    input.dataset.mentionPicker = '1';
    const id = `mention-list-${++seq}`;
    const list = el('div', 'mention-list'); list.id = id; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Mention an agent'); list.hidden = true;
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-haspopup', 'listbox'); input.setAttribute('aria-controls', id); input.setAttribute('aria-expanded', 'false');
    (input.closest('.mb-post-card') || input.parentElement).append(list);
    let active = 0, current = null, dismissed = null; // dismissed: where Escape closed the list (the @ and the text then): moving the caret there does not open it again, typing does

    const sync = () => {
        const open = !list.hidden;
        input.setAttribute('aria-expanded', String(open));
        const opt = open && list.children[active];
        if (opt) input.setAttribute('aria-activedescendant', opt.id); else input.removeAttribute('aria-activedescendant');
    };
    const close = () => { list.hidden = true; list.replaceChildren(); current = null; sync(); };
    const mark = (i) => { active = i; [...list.children].forEach((o, k) => { o.classList.toggle('active', k === i); o.setAttribute('aria-selected', String(k === i)); }); list.children[i]?.scrollIntoView?.({ block: 'nearest' }); sync(); };
    function pick(name) {
        if (!current) return;
        const text = input.value, cursor = input.selectionStart, before = text.slice(0, current.at), after = text.slice(cursor);
        const spaced = /^\s/.test(after); // a picked name in the middle of a text is followed by the space already there, not a second one
        input.value = `${before}@${name}${spaced ? '' : ' '}${after}`;
        input.selectionStart = input.selectionEnd = before.length + name.length + 2;
        close();
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true })); // the box grows, and no list reopens: the cursor is past the space
    }
    function open() {
        const q = mentionQuery(input.value, input.selectionStart);
        if (!q) { close(); return; }
        if (dismissed && dismissed.at === q.at && dismissed.value === input.value) return; // closed by Escape and the text is as it was
        const choices = mentionChoices(q.query, typeof names === 'function' ? names() : names);
        if (!choices.length) { close(); return; }
        current = q;
        const kept = list.hidden ? '' : (list.children[active] && list.children[active].dataset.name); // a re-read keeps the highlighted row when it is still there
        list.replaceChildren(...choices.map((n, i) => {
            const o = el('div', 'mention-option'); o.id = `${id}-opt-${i}`; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', 'false'); o.dataset.name = n;
            o.append(el('span', 'mention-name', n === ALL ? '@all' : n));
            if (n === ALL) o.append(el('span', 'mention-note', 'Notify all agents'));
            o.addEventListener('mousedown', (e) => { e.preventDefault(); pick(n); }); // before the box loses the focus
            return o;
        }));
        list.hidden = false;
        mark(Math.max(0, choices.indexOf(kept)));
    }
    input.addEventListener('input', open);
    input.addEventListener('click', open);
    input.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) open(); }); // moving the caret fires no input event: the list follows the @ the caret is at, or closes
    input.addEventListener('blur', () => { if (!list.hidden) close(); });
    input.addEventListener('keydown', (e) => {
        if (list.hidden || e.isComposing) return;
        const n = list.children.length;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') mark((active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) || e.key === 'Tab') pick(list.children[active].dataset.name);
        else if (e.key === 'Escape') { dismissed = { at: current.at, value: input.value }; close(); }
        else return;
        e.preventDefault(); e.stopPropagation(); // the composer's own Enter (send) is not reached while the list is open
    });
}
