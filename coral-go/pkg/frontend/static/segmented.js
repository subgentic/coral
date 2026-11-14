/* A segmented control (or a row of text cards) drawn over a <select> (#7391): the select stays the form's one field (every script and test that reads or sets its value keeps working, its value is what is sent), and this is its
 * view: a radiogroup of buttons that follows the select, whether the person pressed one, a script set the select's value, or the select's options were rebuilt (a provider that takes other thinking levels).
 *   segmentSelect(select, { label, cards })   returns the group element; the group is put right after the select, which is hidden
 * Keys: the arrows (and Home and End) move the choice and select it, one tab stop for the group (the checked one), as a native radio group does. */
import { importOnce } from './import_once.js';
const { markOf } = await importOnce('./agent_marks.js');
let seq = 0;

export function segmentSelect(select, { label = '', labelledby = '', cards = false, className = '', list = false } = {}) {
    if (!select || select._segmented) return select && select._segmented;
    const group = document.createElement('div');
    group.className = `seg-group${list ? ' seg-list' : cards ? ' seg-cards' : ' btn-seg'}${className ? ' ' + className : ''}`;
    group.setAttribute('role', 'radiogroup');
    if (labelledby) group.setAttribute('aria-labelledby', labelledby); else if (label) group.setAttribute('aria-label', label);
    group.id = `seg-${++seq}`;
    if (list) importOnce('./lazy_styles.js').then(m => m.loadStyles('permission_mode_list.css')).catch(() => {}); // the rows' layout: not at start (#15886)
    select.after(group);
    select.classList.add('seg-source');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;
    select._segmented = group;
    let rebuilding = false;
    const options = () => [...select.options].filter(o => !o.hidden && !o.disabled && !(list && o.value === '')); // the list has no 'Not set' row: nothing saved reads as Auto, which it is
    const draw = () => {
        if (rebuilding) return;
        rebuilding = true;
        const keep = group.contains(document.activeElement) ? document.activeElement.dataset.value : null; // a rebuild must not drop the focus
        group.replaceChildren();
        const cur = select.value || (list ? 'auto' : '');
        for (const o of options()) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'btn seg-btn'; b.setAttribute('role', 'radio'); b.dataset.value = o.value;
            if (select.classList.contains('acf-agent-type') && markOf(o.value)) b.setAttribute('data-mark', markOf(o.value)); // the provider control: OpenCode's and Hermes's letter (#12169)
            const on = o.value === cur;
            b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1;
            const name = document.createElement('span'); name.className = 'seg-name'; name.textContent = o.textContent.trim();
            if (list) { const m = document.createElement('span'); m.className = 'seg-mark'; m.setAttribute('aria-hidden', 'true'); b.append(m); } // the radio mark: a list of rows is read as radios
            b.append(name);
            if (list) { name.id = `${group.id}-${o.value}-n`; b.setAttribute('aria-labelledby', name.id); } // the radio is named by its mode, and the explanation is its description (not part of the name)
            if (list && (o.dataset.desc || o.title)) { const d = document.createElement('span'); d.className = 'seg-desc'; d.id = `${group.id}-${o.value}-d`; d.textContent = o.dataset.desc || o.title; b.append(d); b.setAttribute('aria-describedby', d.id); } // every row says what it lets the agent do, chosen or not (#15886)
            if (list && o.dataset.warn) { const w = document.createElement('span'); w.className = 'seg-warn'; w.textContent = o.dataset.warn; b.append(w); }
            if (cards && o.dataset.desc) { const d = document.createElement('span'); d.className = 'seg-desc'; d.textContent = o.dataset.desc; b.append(d); }
            b.addEventListener('click', () => choose(o.value));
            group.append(b);
        }
        if (!group.querySelector('[tabindex="0"]')) group.querySelector('.seg-btn')?.setAttribute('tabindex', '0');
        rebuilding = false;
        if (keep !== null) group.querySelector(`[data-value="${CSS.escape(keep)}"]`)?.focus();
    };
    const choose = (value) => {
        if (select.value === value) return;
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        draw();
        group.querySelector(`[data-value="${CSS.escape(value)}"]`)?.focus();
    };
    group.addEventListener('keydown', e => {
        const list = [...group.querySelectorAll('.seg-btn')];
        const i = list.findIndex(b => b === document.activeElement);
        if (i < 0) return;
        const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        choose(list[(to + list.length) % list.length].dataset.value);
    });
    // A script that sets select.value (a persona, a saved configuration, the provider's default) moves the view with it.
    const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', { configurable: true, get() { return proto.get.call(this); }, set(v) { proto.set.call(this, v); draw(); } });
    new MutationObserver(draw).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'title'] });
    select.addEventListener('change', draw);
    draw();
    return group;
}

/** Arrow keys for a strip of plain buttons that is not drawn over a select (the New job dialog's Type and When, #15836): the arrows (and Home and End) move to the next button and press it, one tab stop for the strip
 *  (the pressed one), as segmentSelect's radiogroup does. The buttons keep their own click and their aria-pressed; the tab stop follows whichever is pressed, however it was pressed. */
export function stripKeys(group) {
    const list = () => [...group.querySelectorAll(':scope > .btn')];
    const stops = () => { const all = list(), on = all.find(b => b.getAttribute('aria-pressed') === 'true') || all[0]; for (const b of all) b.tabIndex = b === on ? 0 : -1; };
    group.addEventListener('keydown', e => {
        const all = list(), i = all.indexOf(document.activeElement);
        if (i < 0) return;
        const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        const next = all[(to + all.length) % all.length];
        next.click(); next.focus();
    });
    new MutationObserver(stops).observe(group, { attributes: true, attributeFilter: ['aria-pressed'], subtree: true });
    stops();
    return stops;
}
