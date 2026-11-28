/* The approved Goals toolbar keeps all state choices/counts in one menu. */
import { importOnce } from './import_once.js';
const { el } = await importOnce('./dom_el.js');
const { moreMenu } = await importOnce('./more_menu.js');
export function mountGoalStateMenu(node, pills, readCounts) {
    node.querySelector('.gl-state-menu')?.remove();
    node.querySelectorAll('.team-tb-pills,.team-tb-select,.inbox-pill-field').forEach(e => e.remove());
    const row = node.querySelector('.list-bar-search-row'); if (!row || !pills) return;
    const menu = moreMenu('goals-state-menu', pills.items.map(it => ({ label: `${it.label}${it.count === undefined ? '' : ` ${it.count}`}`, pressed: it.key === pills.current, run: () => pills.onPick(it.key) })), { label: 'Goal state', wrapClass: 'task-more gl-state-menu' });
    menu.querySelectorAll('[role=menuitemcheckbox]').forEach((item, i) => { item.replaceChildren(el('span', null, pills.items[i].label), document.createTextNode(' '), el('span', 'gl-state-count', pills.items[i].count === undefined ? '…' : String(pills.items[i].count))); });
    const b = menu.querySelector('button'); b.textContent = `State: ${pills.items.find(it => it.key === pills.current)?.label || 'All'} ▾`; b.setAttribute('aria-label', b.textContent);
    if (readCounts) b.addEventListener('click', async () => { try { const counts = await readCounts(); if (menu.isConnected) menu.querySelectorAll('.gl-state-count').forEach((n, i) => { n.textContent = String(counts[pills.items[i].key]); }); } catch { /* Keep unknown counts explicit; choices remain usable. */ } });
    row.insertBefore(menu, row.querySelector('.list-bar-toggle'));
}
