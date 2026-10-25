/* A dashboard whose session has ended (#3418, #3939). When an /api call answers 401 (strict mode:
 * dashboard_auth_required; or the API-key sign-in on a remote browser), the page pauses its pollers and live feed and goes to the /auth sign-in page
 * (signed_out.js), which returns to this page once signed in: the locked page, or the key form. The Coral Hub has its own sign-in (cloud.js) and is not handled here. */

import { enterSignedOut, authUrlFor } from './signed_out.js';

export { authUrlFor };

/** Whether a 401's body means the dashboard is signed out (#3528): strict mode's
 *  dashboard_auth_required, or the auth middleware's plain "Unauthorized" (the API-key sign-in on
 *  a remote browser). Any other JSON 401 (an agent-only route's session_token_required, an
 *  identity refusal) is the caller's to show: going to /auth would not help a signed-in user. */
export function isSignedOut401(bodyText) {
    let body;
    try { body = JSON.parse(bodyText); } catch { return true; }
    if (!body || typeof body !== 'object') return true;
    return body.code === 'dashboard_auth_required' || body.error === 'dashboard_auth_required';
}

/** Handle a 401 from an /api call that means signed out: the sign-in page, once. */
export function handleUnauthorized(win = window) {
    enterSignedOut(win);
}
