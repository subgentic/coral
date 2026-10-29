/* Whether the auto-update UI is on (#5275): the server's own answer. GET /api/system/update answers 404 while the update feature is off and `enabled: false` while the updater's apply is off, so the UI is
 * shown only on `enabled: true` (#5280 step 3 C). It starts false; loadUpdatesFlag() asks once at startup, and every local status the UI reads (update_api.js) refreshes it. It has no imports, so
 * the modules that hang the UI on a page (Settings' tab list, the top bar, the Servers badge) can read it synchronously. A dashboard served through Coral Hub never asks: this computer's own
 * updates are for its own dashboard. */
import { dropBody, isCloud } from './server_base.js';

let on = false;
let probe = null;

export const updatesUiOn = () => on;

/** Set by whoever has just read the local status (and by the suites). */
export function setUpdatesEnabled(v) { on = v === true; }

/** Ask the local server once whether the updater is on: true when GET /api/system/update answers and says `enabled`. A server without the feature (404) or one that does not answer leaves it off. */
export function loadUpdatesFlag() {
    if (isCloud()) return Promise.resolve(false);
    if (!probe) {
        probe = fetch('/api/system/update', { headers: { Accept: 'application/json' } })
            .then(r => { if (r.ok) return r.json(); dropBody(r); return null; }) // a refusal's body is given up, not left unread
            .then(b => { if (b && typeof b === 'object') setUpdatesEnabled(b.enabled); return on; })
            .catch(() => on);
    }
    return probe;
}

/** Set when a person starts an update (the version it goes to); the page that comes back says "Coral is now X" and clears it (#10834). */
export const UPDATED_KEY = 'coral-updated-to';
