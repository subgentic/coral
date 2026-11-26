import { importOnce } from './import_once.js';
import { isCloud } from './server_base.js';
let known; // whether this browser is the owner's: it does not change while the page lives, so it is read once (an answer read again on every focus or visibility change was one more auth-status request each time, #21642)
/** True when this browser is the computer's own operator. Not in the cloud (it has no owner-only routes) and not when the auth status says a proxied or other-user browser is looking: those get 403 other_user on the owner-only routes (#21543). */
export const operatorHere = async () => {
    if (isCloud()) return false;
    if (known === undefined) {
        const status = await (await importOnce('./auth_status_read.js')).readAuthStatus();
        if (!status) return true; // no answer: ask again next time, and let the call through as before
        known = status.local !== false;
    }
    return known;
};
