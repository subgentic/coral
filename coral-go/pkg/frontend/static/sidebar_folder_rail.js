/* The collapsed sidebar's icons for the tabs whose list is views or folders (#15820, as the Inbox's own rail since #15347): one button per row of Automations, Skills and Analytics, the open one marked, in
 * place of the three bare buttons. Each tab has its own nav (so a tab keeps its icons while another is on screen); the CSS shows the one that belongs to the layout's pane. */
import { loadStyles } from './lazy_styles.js';
await loadStyles('sidebar_folder_rail.css');

/** items: [{ key, label, icon, count? }]; here: the open key; pick(key): what the row does. */
const RAIL_IDS = { automations: 'sidebar-rail-automations', skills: 'sidebar-rail-skills', tokens: 'sidebar-rail-tokens' };
export function drawFolderRail(pane, noun, items, here, pick) {
    const after = document.getElementById('sidebar-rail-inbox');
    if (!after) return;
    let rail = document.getElementById(RAIL_IDS[pane]);
    if (!rail) { rail = document.createElement('nav'); rail.id = RAIL_IDS[pane]; rail.className = 'sidebar-rail-views'; after.after(rail); }
    rail.setAttribute('aria-label', `${noun} views`);
    rail.replaceChildren(...items.filter(it => it.icon).map(it => {
        const b = document.createElement('button'), n = Number(it.count) || 0, name = n ? `${it.label}, ${n}` : it.label;
        b.type = 'button'; b.className = 'btn btn-quiet btn-icon btn-small sidebar-rail-btn sidebar-rail-folder'; b.dataset.key = it.key; b.title = it.label; b.setAttribute('aria-label', name);
        if (it.key === here) b.setAttribute('aria-current', 'page');
        const glyph = document.createElement('span'); glyph.className = 'view-list-icon top-bar-icon material-icons'; glyph.setAttribute('aria-hidden', 'true'); glyph.textContent = it.icon; b.append(glyph);
        b.addEventListener('click', () => pick(it.key));
        return b;
    }));
}
