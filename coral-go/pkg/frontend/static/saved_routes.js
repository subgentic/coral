/* The bookmark write routes through Coral Hub (coral-hub #259026): Save, Done and Remove are offered only for the routes the Hub reports open in the account (saved_routes: { save, done, remove }, each true), and always on a computer's own page.
 * The computer still decides who may write (owner-only there). Lazy: nothing of it is on the start path; a module that offers a write awaits loadSavedRoutes() once. */
import { isCloud, nativeSaved } from './server_base.js';
import { readAccount } from './account_info.js';

let routes = {};
export const loadSavedRoutes = () => (isCloud() ? Promise.resolve(readAccount()).then(a => { routes = a?.saved_routes || {}; }, () => {}) : Promise.resolve());
export const savedRouteOpen = name => !isCloud() || (nativeSaved() && routes[name] === true);
/** Show or hide the Save buttons under root by the Hub's save route (the buttons state is not painted through the Hub). */
async function showSave(root) {
    const open = savedRouteOpen('save');
    for (const b of root.querySelectorAll('.chat-save-btn, .mb-save-btn')) b.hidden = !open;
}
// Loaded when the Hub's native Saved is on: the Save buttons of a chat or board that is drawn (now or later) follow the Hub's open routes.
await loadSavedRoutes();
for (const id of ['live-history-messages', 'history-messages', 'mb-messages']) {
    const root = document.getElementById(id);
    if (!root || root._savedRoutesWatch) continue;
    root._savedRoutesWatch = new MutationObserver(() => showSave(root));
    root._savedRoutesWatch.observe(root, { childList: true, subtree: true });
    showSave(root);
}
