/* The address the page was served at, until the person goes somewhere else (#12406). The app rewrites the address as it starts (an agent that cannot be read yet shows the Agents list, a route is written in its canonical form),
 * so by the time a 401 sends the page to the sign-in page the address is no longer the one the person opened: a deep link to an agent's Files tab came back as /agents. The sign-in page's return_to uses this one while it
 * stands; a push or Back (the person moving on) forgets it. No imports. */
let served = '';
export const setServedAddress = addr => { served = typeof addr === 'string' ? addr : ''; };
export const servedAddress = () => served;
