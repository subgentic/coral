/* The folder picker's local name filter. Loaded only when a picker opens. */
import { loadStyles } from './lazy_styles.js';
import { escapeHtml, escapeAttr } from './utils.js';
export async function mount(browser) {
    await loadStyles('launch_folder.css');
    const list = browser.querySelector('.dir-browser-list'), path = browser.querySelector('.dir-browser-path');
    if (!list || browser.querySelector('.dir-browser-search')) return;
    const input = document.createElement('input'); input.type = 'search'; input.className = 'field dir-browser-search'; input.placeholder = 'Filter folders'; input.setAttribute('aria-label', 'Filter folders in this directory');
    const empty = document.createElement('p'); empty.className = 'settings-hint'; empty.textContent = 'No folders match this filter.'; empty.hidden = true;
    browser.insertBefore(input, list); browser.insertBefore(empty, list);
    let current = path?.textContent;
    const apply = () => {
        if (path?.textContent !== current) { current = path?.textContent; input.value = ''; }
        const query = input.value.trim().toLocaleLowerCase(), entries = [...list.querySelectorAll('li[data-name]')];
        for (const entry of entries) entry.hidden = !!query && !entry.dataset.name.toLocaleLowerCase().includes(query);
        empty.hidden = !query || !entries.length || entries.some(entry => !entry.hidden);
    };
    input.addEventListener('input', apply);
    const observer = new MutationObserver(apply);
    observer.observe(list, { childList: true });
    if (path) observer.observe(path, { childList: true, subtree: true });
    apply();
}

export function renderEntries(list, entries) {
    if (!entries.length) {
        list.innerHTML = '<li class="empty-state">No subdirectories</li>';
        return;
    }

    list.innerHTML = entries.map(name =>
        `<li data-on-click="browser-nav" data-name="${escapeAttr(name)}" title="${escapeAttr(name)}"><button type="button" class="row-btn">
        <span class="dir-icon material-icons" aria-hidden="true">folder</span>
        <span class="dir-name">${escapeHtml(name)}</span>
        </button></li>`
    ).join("");
}
