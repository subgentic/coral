/* The address the page was served at, until the person goes somewhere else (#12406). The app rewrites the address as it starts (an agent that cannot be read yet shows the Agents list, a route is written in its canonical form),
 * so by the time a 401 sends the page to the sign-in page the address is no longer the one the person opened: a deep link to an agent's Files tab came back as /agents. The sign-in page's return_to uses this one while it
 * stands; a push or Back (the person moving on) forgets it. No imports. */
let served = '';
export const setServedAddress = addr => { served = typeof addr === 'string' ? addr : ''; };

/** The address a sign-in must bring the person back to, from the location on screen (#12406, #12432): the address the page was opened at when that is BELOW the one on screen and the person has not moved on (the app shortened a
 *  deep link it could not show yet: /agents/@server/session/files became /agents/@server/session), else the one on screen. Any other rewrite (a legacy link, the bare start, a dropped fragment) keeps the canonical address.
 *  The result is the page's own location: callers still refuse anything that is not a same-origin path. */
export function returnAddress(loc, { hash = true } = {}) {
    const here = (loc.pathname || '/') + (loc.search || '') + (hash ? (loc.hash || '') : ''), base = (loc.pathname || '').replace(/\/+$/, '');
    const servedPath = served.split(/[?#]/)[0];
    return base && served && servedPath.startsWith(base + '/') ? served : here;
}
