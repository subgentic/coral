/* A segmented control (or a row of text cards) drawn over a <select> (#7391): the select stays the form's one field (every script and test that reads or sets its value keeps working, its value is what is sent), and this is its
 * view: a radiogroup of buttons that follows the select, whether the person pressed one, a script set the select's value, or the select's options were rebuilt (a provider that takes other thinking levels).
 *   segmentSelect(select, { label, cards })   returns the group element; the group is put right after the select, which is hidden
 * Keys: the arrows (and Home and End) move the choice and select it, one tab stop for the group (the checked one), as a native radio group does. */
let seq = 0;

export function segmentSelect(select, { label = '', labelledby = '', cards = false, className = '' } = {}) {
    if (!select || select._segmented) return select && select._segmented;
    const group = document.createElement('div');
    group.className = `seg-group${cards ? ' seg-cards' : ' btn-seg'}${className ? ' ' + className : ''}`;
    group.setAttribute('role', 'radiogroup');
    if (labelledby) group.setAttribute('aria-labelledby', labelledby); else if (label) group.setAttribute('aria-label', label);
    group.id = `seg-${++seq}`;
    select.after(group);
    select.classList.add('seg-source');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;
    select._segmented = group;
    let rebuilding = false;
    const options = () => [...select.options].filter(o => !o.hidden && !o.disabled);
    const draw = () => {
        if (rebuilding) return;
        rebuilding = true;
        const keep = group.contains(document.activeElement) ? document.activeElement.dataset.value : null; // a rebuild must not drop the focus
        group.replaceChildren();
        const cur = select.value;
        for (const o of options()) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'btn seg-btn'; b.setAttribute('role', 'radio'); b.dataset.value = o.value;
            const on = o.value === cur;
            b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1;
            const name = document.createElement('span'); name.className = 'seg-name'; name.textContent = o.textContent.trim();
            b.append(name);
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
    new MutationObserver(draw).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });
    select.addEventListener('change', draw);
    draw();
    return group;
}
