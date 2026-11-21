/* The computer bar (#20207, mock #20178): ONE place under a page's title that says which computer the page reads, the same words on every per-computer page.
 * A button with the computer's dot and name (a one-word chip only when it is offline) opens a list: "All computers" when the page can merge, then the online computers,
 * a divider, then the offline ones (greyed, still selectable). The order comes from machineChoices (online first, most recently seen first inside each group). On a phone the list is a sheet. */
import { importOnce } from './import_once.js';
const { loadStyles } = await importOnce('./lazy_styles.js');
await loadStyles('computer_bar.css');
const { machineLabel, machineOnline, machineSeen } = await importOnce('./analytics_machine.js');
const { formatLastSeen } = await importOnce('./server_status.js');

export const ALL_COMPUTERS = 'all';
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const dotOf = id => { const d = node('span', 'computer-dot'); d.setAttribute('data-computer-state', machineOnline(id) ? 'online' : 'offline'); d.setAttribute('aria-hidden', 'true'); return d; };
const nameOf = id => id === ALL_COMPUTERS ? 'All computers' : !id ? '' : machineLabel(id);
const seenText = id => machineOnline(id) ? 'Online' : `Offline · last seen ${formatLastSeen(machineSeen(id))}`;

/** Build the bar. choices: ids in picker order; current: the id (or ALL_COMPUTERS) being read; all: offer "All computers"; onPick(id) is called with the chosen id. */
export function computerBar({ choices, current, all = false, onPick, id = '', emptyText = 'No computers online' }) {
    const root = node('div', 'computer-bar');
    if (id) root.id = id;
    const label = node('span', 'computer-bar-label', 'Computer');
    const button = node('button', 'btn computer-bar-button'); button.type = 'button';
    button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-label', `Computer: ${nameOf(current) || emptyText}`);
    if (current && current !== ALL_COMPUTERS) button.append(dotOf(current));
    button.append(node('span', 'computer-bar-name', nameOf(current) || emptyText));
    if (!choices.some(machineOnline) && !current) button.disabled = true;
    if (current && current !== ALL_COMPUTERS && !machineOnline(current)) button.append(node('span', 'chip computer-chip', 'Offline'));
    button.append(node('span', 'computer-bar-caret'));
    const list = node('div', 'computer-bar-list'); list.setAttribute('role', 'listbox'); list.hidden = true;
    const online = choices.filter(machineOnline), offline = choices.filter(c => !machineOnline(c));
    const options = [];
    const option = cid => {
        const o = node('button', 'computer-bar-option'); o.type = 'button'; o.setAttribute('role', 'option'); o.dataset.computer = cid;
        o.setAttribute('aria-selected', String(cid === current));
        if (cid !== ALL_COMPUTERS) o.append(dotOf(cid));
        const text = node('span', 'computer-bar-text'); text.append(node('span', 'computer-bar-title', nameOf(cid)));
        text.append(node('span', 'computer-bar-sub', cid === ALL_COMPUTERS ? `${choices.length} linked · ${offline.length} offline` : seenText(cid)));
        o.append(text);
        if (cid !== ALL_COMPUTERS && !machineOnline(cid)) o.append(node('span', 'chip computer-chip', 'Offline'));
        o.addEventListener('click', () => { close(); if (cid !== current) onPick(cid); });
        options.push(o); return o;
    };
    if (all && choices.length > 1) list.append(option(ALL_COMPUTERS));
    if (online.length) { list.append(node('div', 'computer-bar-group', 'Online'), ...online.map(option)); }
    if (online.length && offline.length) { const hr = node('div', 'computer-bar-divider'); hr.setAttribute('role', 'separator'); list.append(hr); }
    if (offline.length) { list.append(node('div', 'computer-bar-group', 'Offline'), ...offline.map(option)); }
    function close(refocus) { list.hidden = true; button.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); if (refocus) button.focus(); }
    const outside = e => { if (!root.contains(e.target)) close(); };
    function open() { list.hidden = false; button.setAttribute('aria-expanded', 'true'); document.addEventListener('pointerdown', outside, true); (options.find(o => o.getAttribute('aria-selected') === 'true') || options[0])?.focus(); }
    button.addEventListener('click', () => list.hidden ? open() : close(true));
    const neighbour = step => options[(options.indexOf(document.activeElement) + step + options.length) % options.length];
    root.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); close(true); return; }
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !list.hidden) { e.preventDefault(); neighbour(e.key === 'ArrowDown' ? 1 : -1)?.focus(); }
    });
    root.append(label, button, list);
    return root;
}
