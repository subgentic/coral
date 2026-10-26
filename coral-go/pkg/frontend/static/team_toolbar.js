/* The one toolbar of every list tab of the team page (#7717, the operator: "a consistent UI across our team tabs, a search bar and filters all in a single line"). Goals, Messages, Tasks, Agents, Artifacts and
 * Knowledge each have ONE line: the search field (it grows), then the tab's state pills (and, where the tab has them, the Filters icon and More icon of the list bar), then the tab's primary action at the right
 * (New goal, New task, Distill knowledge), the buttons the height of the field. When the pills do not fit the line they become one compact select on the same line (a container query, team_page.css), and a phone
 * wraps the line at most once. A tab with a list bar (Tasks, Messages, Artifacts: list_bar.js) puts its pills and action INTO the bar's own row (`adopt`); a tab without one (Goals, Agents, Knowledge) gets a row
 * with a search field of the same make (`build`), so no tab draws its own. Text is set with textContent only.
 *
 *   build({ label, placeholder, value, onSearch, pills, action })  -> the row element (a search field, the pills, the action)
 *   adopt(row, { pills, action })                                  -> puts the pills and the action into a list bar's `.list-bar-search-row`
 *   pills: { label, items: [{ key, label, count }], current, onPick(key) }                                       */
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };

/** The pills of a tab as one group of buttons, and the same choice as a compact select (shown instead of the group when the line is narrow). */
function pillElements(p) {
    const group = el('div', 'goals-chips goals-chips-row team-tb-pills'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', p.label);
    const select = el('select', 'list-bar-select team-tb-select'); select.setAttribute('aria-label', p.label);
    for (const it of p.items) {
        const text = `${it.label} ${it.count}`;
        const b = el('button', 'goals-chip', text); b.type = 'button'; b.dataset.filter = it.key; b.setAttribute('aria-pressed', String(p.current === it.key));
        if (!it.count && it.key !== 'all') b.classList.add('goals-chip-zero');
        b.addEventListener('click', () => p.onPick(it.key));
        group.append(b);
        const o = el('option', null, text); o.value = it.key; o.selected = p.current === it.key; select.append(o);
    }
    select.addEventListener('change', () => p.onPick(select.value));
    return [group, select];
}

/** A filter that is on, as a removable chip ("No goal ×"): pressing it takes the filter off. */
function chipButton(c) {
    const b = el('button', 'goals-chip team-tb-chip', `${c.label} \u00d7`); b.type = 'button'; b.setAttribute('aria-label', c.aria || `Remove the ${c.label} filter`); b.title = c.aria || `Remove the ${c.label} filter`; b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', c.onRemove);
    return b;
}

/** Put the pills and the action into a list bar's search row: [search][pills or select][Filters][More][action]. Called on every draw: what an earlier draw put there goes first. */
export function adopt(row, { pills = null, chip = null, action = null } = {}) {
    for (const old of row.querySelectorAll('.team-tb-pills, .team-tb-select, .team-tb-chip, .team-tb-action')) old.remove();
    row.classList.add('team-toolbar-row');
    const first = row.querySelector('.list-bar-toggle') || row.querySelector('.list-bar-more');
    if (pills) { const [group, select] = pillElements(pills); for (const e of [group, select]) { if (first) row.insertBefore(e, first); else row.append(e); } group.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }
    if (chip) { const c = chipButton(chip); if (first) row.insertBefore(c, first); else row.append(c); }
    if (action) { action.classList.add('team-tb-action'); row.append(action); }
    return row;
}

/** A row of its own for a tab with no list bar: a search field in the list bar's make (so it looks and measures the same), then the pills, then the action. */
export function build({ id = '', label, placeholder, value = '', onSearch = null, pills = null, action = null }) {
    const row = el('div', 'list-bar-search-row team-toolbar-row');
    const wrap = el('div', 'list-bar-search-wrap');
    const q = el('input', 'list-bar-search'); q.type = 'search'; q.placeholder = placeholder; q.maxLength = 200; q.autocomplete = 'off'; q.spellcheck = false; q.value = value; if (id) q.id = id;
    q.setAttribute('aria-label', label);
    wrap.append(q);
    row.append(wrap);
    if (onSearch) q.addEventListener('input', () => { onSearch(q.value); const again = id && document.getElementById(id); if (again && again !== q) { again.focus({ preventScroll: true }); try { again.setSelectionRange(again.value.length, again.value.length); } catch { /* a search field has a caret */ } } }); // the tab is drawn again for the new text: the caret goes on in the new field
    if (pills) { const [group, select] = pillElements(pills); row.append(group, select); }
    if (action) { action.classList.add('team-tb-action'); row.append(action); }
    return row;
}
