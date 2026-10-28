/* The Servers entry and lifecycle for registered remotes and Cloud machines.
 * Source adapters keep API contracts separate; form/detail components retain their existing interactions. */
import { importOnce } from './import_once.js';
import { isHub, initHub, isCloud } from './server_base.js';
import { onBuilt } from './lazy_dom.js';
import { resetServersBar } from './server_search.js';
import { createServerController, serverSources } from './server_controller.js';

/** Unhide hub-only entry points. Safe to call on every page load. */
export async function initServersUi() {
    try { await initHub(); } catch { /* treated as non-hub */ }
    const hub = isHub();
    document.querySelectorAll('[data-hub-only]').forEach(el => { el.style.display = hub ? '' : 'none'; });
    // The top-bar menu's Servers item, once the menu is built (#4500).
    onBuilt('top-bar-settings-menu', menu => menu.querySelectorAll('[data-hub-only]').forEach(el => { el.style.display = hub ? '' : 'none'; }));
    const { updateServersTabVisibility } = await importOnce('./servers_tab.js');
    updateServersTabVisibility();
    return hub;
}

/** Open the Servers tab (the settings menu's "Servers" entry), optionally at a row. */
export async function showServersModal(focusId) {
    if (!isCloud() && !isHub()) return;   // hub features are off: no UI, no /api/servers calls
    const { openServersTab } = await importOnce('./servers_tab.js');
    return openServersTab(focusId);
}

let active = null;
let navSeq = 0;
const sources = new Map();

/** One list entry for both sources. The explicit source is also used by isolated view tests. */
export async function renderServersInto(el, { source = isCloud() ? 'cloud' : 'registered' } = {}) {
    const seq = ++navSeq;
    if (active && active.source !== source) { active.controller.stop(); active.view.leave(); active = null; }
    let item = sources.get(source);
    if (!item) {
        const { serverView: view } = source === 'cloud'
            ? await importOnce('./cloud_server_view.js', 'the server list')
            : await importOnce('./registered_server_view.js', 'the server list');
        if (seq !== navSeq) return; // a stale import must not replace the active controller in the cache
        item = { source, view, controller: createServerController(serverSources[source], view) };
        sources.set(source, item);
    }
    if (seq !== navSeq) return;
    active = item;
    item.controller.stop();
    await item.view.mount(el, item.controller.load);
    if (seq !== navSeq) return;
    item.view.render();
    await item.controller.start();
}

export function hideServersModal() {
    navSeq++;
    active?.controller.stop(); active?.view.leave(); active = null;
    resetServersBar();
}

/** The cloud adapter expands inline; local deep links keep their existing row focus. */
export function expandServer(id) { active?.view.expand?.(id); }
export function collapseServer() { active?.view.collapse?.(); }
