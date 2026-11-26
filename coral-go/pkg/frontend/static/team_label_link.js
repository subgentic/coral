/* The "team · computer" label on an Inbox card or row (#21538): the team's name is a link to that team's page on its computer (the computer-aware route, so it works through a Hub too);
 * the computer stays words after it. A plain click goes through the router (app_routes.js, a[data-route]); a link in a row is its own click target, so the row does not open. */
import { build, keyRoute } from './routes.js';
import { keyLabel } from './server_base.js';
import { teamLabel } from './server_status.js';

/** key: the team's identity key (server + board). full: the words the row shows ("team · computer"; default: the label the page uses); name: the team's own words at the start of full (default: its label).
 * When full does not start with name (a hidden name was masked) the whole label is the link. cls: the class of the span that holds it. */
export function teamLabelLink(key, { full = '', name = '', cls = 'team-label' } = {}) {
    full = full || teamLabel(key); name = name || keyLabel(key);
    const head = full.startsWith(name) ? name : full, wrap = document.createElement('span'), a = document.createElement('a');
    a.className = 'team-label-link'; a.href = build(keyRoute('team', key, 'messages')); a.setAttribute('data-route', ''); a.textContent = head; a.setAttribute('aria-label', `Open ${head} team page`);
    wrap.className = cls; wrap.append(a);
    if (full.length > head.length) wrap.append(document.createTextNode(full.slice(head.length))); // " · computer"
    return wrap;
}
