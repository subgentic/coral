/* Coral Hub's first run (#4586): what the Agents page says depends on what the hub's owned-machine list says, once it has loaded (machineState, launch_server.js):
 *   none     no computer is connected: "Connect your first computer" (install Coral on each, then Settings > Network and Hub > Connect to Coral Hub) with an Add a computer link (the hub's /machines/add), in place of the launch cards
 *   offline  computers, none usable: "Your computers are offline"
 *   ready    a machine is usable: with no agents, "No agents yet"
 * A list that has not loaded or failed is never shown as the first run, and a local Coral shows none of this. A folder Browse says "Connect a machine first" (or that the machines are
 * offline) instead of failing. Shared agents and boards the account can already see are left as they are: these are only the empty states. */
import { state } from './state.js';
import { importOnce } from './import_once.js';
import { machineState } from './launch_server.js';
import { refreshPending, waitingRows, expiredRows, waitingText, WAITING_CHECKS, NEVER_CONNECTED, NEVER_CONNECTS_HELP, fillPendingLabels } from './hub_pending.js';

/** Show or hide the first-run screens by a class on the page (the welcome screen's cards and launch cards follow it in CSS). Called whenever the list of servers is read. */
export function syncHubFirstRun() {
    const m = machineState();
    document.body.classList.toggle('hub-no-machine', m === 'none');
    document.body.classList.toggle('hub-machines-offline', m === 'offline');
    const waiting = m === 'none' && waitingRows().length > 0;
    document.body.classList.toggle('hub-machine-waiting', waiting); // the home's card says a computer is awaited, not "Connect your first computer" (#11463 F2)
    const names = document.querySelector('.welcome-waiting-names');
    if (names) names.textContent = waiting ? waitingRows().map(waitingText).join('; ') : '';
    // Nothing connected yet: has a computer been approved that has not connected? (the owner's pending list, #11463 F2). A change redraws the agent list, whose empty state says so.
    if (m === 'none') refreshPending().then(changed => { if (changed) importOnce('./render.js').then(r => r.renderLiveSessions(state.liveSessions)).catch(() => {}); }).catch(() => {});
}

/** The empty agent list for a machine state (the same list is the phone's Agents page), or '' when the ordinary empty line applies. Fixed text only. */
export function hubEmptyListHtml(m) {
    if (m === 'none' && waitingRows().length) {
        // approved, not connected yet: not "Connect your first computer", which reads as if the approval did nothing. Fixed markup; every word and the names are put in by fillHubPending with textContent.
        return '<li class="empty-state hub-connect-empty hub-connect-waiting"><span class="hub-connect-short" data-pending-text="short"></span><span data-pending-labels></span> <span data-pending-text="head"></span>'
            + '<ul class="hub-pending-checks" data-pending-checks></ul><a class="btn btn-primary btn-small" href="/machines/add">Add a computer</a></li>';
    }
    if (m === 'none' && expiredRows().length) {
        return '<li class="empty-state hub-connect-empty hub-connect-expired"><strong data-pending-text="never"></strong> <span data-pending-text="advice"></span> <a class="btn btn-primary btn-small" href="/machines/add">Add a computer</a></li>';
    }
    if (m === 'none') {
        return '<li class="empty-state hub-connect-empty hub-connect-none"><span class="hub-connect-short">No computers connected yet</span><strong>Connect your first computer</strong> <span>Install Coral on each computer. In Coral, go to Settings &gt; Network and Hub &gt; Connect to Coral Hub, and the computer appears here.</span> '
            + '<a class="btn btn-primary btn-small" href="/machines/add">Add a computer</a> '
            + '<span class="hub-phone-note">Coral runs on your computer; open this page there.</span> <a class="btn btn-small hub-get-coral" href="https://coralhub.dev/coral.html#download" target="_blank" rel="noopener noreferrer">Get Coral</a> </li>';
    }
    if (m === 'offline') return '<li class="empty-state hub-connect-empty"><strong>Your computers are offline</strong> <span>Keep Coral running on a connected computer to see its agents here.</span></li>';
    if (m === 'ready') return '<li class="empty-state hub-connect-empty"><strong>No agents yet</strong> <span>Start an agent on a connected computer to see it here.</span></li>';
    return '';
}

/** After the empty list was drawn: put the waiting computers' names in with textContent. */
export function fillHubPending(root) {
    fillPendingLabels(root);
    const words = { short: 'Waiting for a computer to connect', head: 'Check these:', never: NEVER_CONNECTED, advice: NEVER_CONNECTS_HELP };
    root.querySelectorAll('[data-pending-text]').forEach(el => { el.textContent = words[el.dataset.pendingText] || ''; });
    root.querySelectorAll('[data-pending-checks]').forEach(ul => ul.replaceChildren(...WAITING_CHECKS.map(c => { const li = document.createElement('li'); li.textContent = c; return li; })));
}
