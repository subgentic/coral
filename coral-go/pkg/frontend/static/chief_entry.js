/* The Chief entry in the menus and the sidebar (#13167, the Operator: "they could not find Chief"). Loaded lazily: the menu's first opening and the Agents sidebar import it, so it is not in the start.
 * What it says comes from GET /api/chief on the computer shown (owner-only through the Hub, #11470):
 *   'open'      Chief is recorded: its avatar and name, a link to /chief on this computer or, when the Hub serves the page, /chief/<the shown computer's id> (a bare /chief is a 404 there by design);
 *   'setup'     none is set up on this computer: "Set up Chief", which opens Settings > Chief;
 *   'hub-setup' none is set up and the page is the Hub's: "Set up Chief" says, in a line, that Chief is set up on the computer itself (Settings is not the Hub's);
 *   null        the machine refuses (not the owner), or cannot be read: nothing is shown. */
import { serverFetch, contextServer, isCloud } from './server_base.js';
import { importOnce } from './import_once.js';
const { lookOf, avatarNode } = await importOnce('./chief_look.js'); // lazy: its failure is retried

const cache = new Map();
/** The entry's state for the computer shown now, once per page load per computer (force: ask again). */
export function chiefState(force = false) {
    const server = contextServer();
    if (!cache.has(server) || force) {
        cache.set(server, serverFetch(server, '/api/chief', { credentials: 'same-origin', cache: 'no-store' })
            .then(r => (r.ok ? r.json() : null))
            .then(j => {
                if (!j || typeof j !== 'object') return null;
                if (!j.enabled || !j.session_id) return { kind: isCloud() ? 'hub-setup' : 'setup' };
                const look = lookOf(j);
                return { kind: 'open', look, name: look.name || 'Chief', href: isCloud() ? `/chief/${encodeURIComponent(server)}` : '/chief' };
            }).catch(() => null));
    }
    return cache.get(server);
}

/** The avatar node of an 'open' state, as the page draws it. */
export function chiefAvatar(state) { return avatarNode(state.look, state.name); }

/** What "Set up Chief" says through the Hub, where Settings > Chief is not the Hub's. */
export const HUB_SETUP_NOTE = 'Chief is set up on the computer itself: open Coral there and choose Settings > Chief.';

/** Fill the Agents sidebar's slot above New agent. A link when Chief is set up, a button when it is not, nothing when the machine refuses. */
export async function paintSidebarChief() {
    const slot = document.getElementById('sidebar-chief-slot');
    if (!slot) return;
    const mine = contextServer();
    const st = await chiefState();
    if (mine !== contextServer()) return; // another computer is shown now: its own paint follows
    slot.replaceChildren();
    slot.hidden = !st;
    if (!st) return;
    let node;
    if (st.kind === 'open') {
        node = document.createElement('a'); node.href = st.href; node.className = 'btn btn-quiet sidebar-chief-link';
        node.append(chiefAvatar(st), Object.assign(document.createElement('span'), { textContent: st.name }));
    } else {
        node = document.createElement('button'); node.type = 'button'; node.className = 'btn btn-quiet sidebar-chief-link';
        node.append(Object.assign(document.createElement('span'), { className: 'material-icons', textContent: 'smart_toy' }), Object.assign(document.createElement('span'), { textContent: 'Set up Chief' }));
        if (st.kind === 'setup') node.setAttribute('data-on-click', 'open-chief-settings'); else node.setAttribute('data-on-click', 'chief-hub-note');
        node.firstChild.setAttribute('aria-hidden', 'true');
    }
    slot.append(node);
}
