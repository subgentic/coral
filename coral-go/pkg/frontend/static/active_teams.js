/* The agent list shows the teams that are active (#15744, the Operator via coral-hub: leftover test boards filled the phone drawer): a team with an agent that is awake or a message
 * waiting for one of its agents, newest message first; the rest are one row away (Show all teams), remembered in this browser. The open team is always listed, and so is every team
 * while the search box has words in it. Loaded when the list holds more than a few teams; group_cards.js asks for it only then, so the first paint carries none of these bytes. */
import { browserLocal } from './safe_storage.js';
import { registerActions } from './actions.js';
import { redrawLiveList } from './list_hooks.js';
import { escapeHtml } from './utils.js';
import { state } from './state.js';
import { _getGroupOrder } from './list_order.js';

const KEY = 'coral-teams-show-all';
export const FEW = 4; // up to this many teams are all listed: nothing to hide
const asleepOnly = list => list.every(s => s.sleeping) && !list.some(s => Number(s.board_unread) > 0);
const newest = list => Math.max(0, ...list.map(s => Date.parse(s.last_message?.at) || 0));
const showingAll = () => browserLocal.get(KEY) === 'true';
const searching = () => !!(document.getElementById('agent-search-input')?.value || '').trim();

/** The row under the teams: Show all teams (n idle), or Show active teams only once they are all listed. */
const row = (hide, n) => `<li class="teams-show-all" style="list-style:none;padding:var(--space-2, 8px) var(--space-3, 12px)"><button type="button" class="btn btn-quiet btn-small" data-on-click="teams-show-all" aria-expanded="${hide ? "false" : "true"}">${escapeHtml(hide ? `Show all teams (${n} idle)` : 'Show active teams only')}</button></li>`;

/** The entries ([key, sessions]) to draw: active first, newest message first when the person set no order; the array carries the row under it (.row). */
export function pick(entries) {
    const open = state.selectedTeam, ordered = _getGroupOrder().length > 0;
    const idle = entries.length <= FEW ? [] : entries.filter(([k, list]) => asleepOnly(list) && k !== open);
    const ranked = ordered ? entries : [...entries].sort((a, b) => (asleepOnly(a[1]) - asleepOnly(b[1])) || (newest(b[1]) - newest(a[1])));
    const hide = !(showingAll() || searching()) && idle.length > 0, shown = hide ? ranked.filter(e => !idle.includes(e)) : ranked;
    shown.row = idle.length && !searching() ? row(hide, idle.length) : '';
    return shown;
}


registerActions({
    'teams-show-all': () => { browserLocal.set(KEY, showingAll() ? 'false' : 'true'); redrawLiveList(); },
});
setTimeout(redrawLiveList, 0); // loaded for the list that asked: draw it again now that the module is registered
