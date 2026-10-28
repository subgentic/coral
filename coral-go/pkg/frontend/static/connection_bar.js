/* The bar that says the live feed is gone (#10296): "No connection, retrying" a few seconds after the feed drops and does not come back, "Back online" for a moment when it does. A strip in the page's flow
 * under the top bar (and the sign-in banner), as the alerts offer is (#10248): it covers no control. Loaded by websocket.js when the feed has been down a few seconds, not at start (page weight). */
import { announceNotice } from './notifications.js';

const ID = 'connection-bar', GONE = 'No connection, retrying', BACK = 'Back online', BACK_MS = 3000;
let _leave = 0;

function bar() {
    let b = document.getElementById(ID);
    if (b) return b;
    b = document.createElement('div'); b.id = ID; b.setAttribute('role', 'status');
    const after = document.getElementById('alerts-offer-banner') || document.getElementById('local-auth-banner') || document.querySelector('header.top-bar');
    if (after) after.after(b); else document.body.prepend(b);
    return b;
}
function say(b, tone, text) { b.className = `notice notice-${tone} notice-bar connection-bar`; if (b.textContent !== text) b.textContent = text; announceNotice(text); }

export function showNoConnection() { clearTimeout(_leave); say(bar(), 'warn', GONE); }

export function showBackOnline() {
    const b = document.getElementById(ID);
    if (!b) return;
    clearTimeout(_leave);
    say(b, 'info', BACK);
    _leave = setTimeout(() => b.remove(), BACK_MS);
}
