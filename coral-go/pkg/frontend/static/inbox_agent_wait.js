/* Waiting on an agent (#19904, the approved two-tab mock): what a row on that tab says about the agent it waits on, and what the Operator can do about it. The agent is Awake, Asleep or Archived (the three states of #19673):
 * an awake one works on it (quiet actions: Open file, Open agent); an asleep one will not read the request until it is woken (amber, Wake); an archived one does not wake by itself (rose, Start agent). Pure reading of the live list;
 * the two buttons are the Agents list's own wake and unarchive, so the agent ends up in the state the Agents tab shows. Built with textContent only. */
import { state } from './state.js';
import { sessionServer } from './server_base.js';
import { liveAgentOf } from './agent_live.js';
import { markHidden } from './visible_marks.js';
import { importOnce } from './import_once.js';
import { el } from './dom_el.js';

/** The agent a sent-back file waits on: its live row (by the file's session, else by name on its team) and its state: 'awake', 'asleep', 'archived', or '' when Coral does not list it. */
export function agentWaitState(review) {
    const who = String(review?.produced_by || '');
    const live = (state.liveSessions || []).find(s => review?.session_id && s.session_id === review.session_id) || liveAgentOf(who, { board: review?.team ? String(review.team).split(':').pop() : '', session: review?.session_id || '' }) || null;
    if (!live) return { state: '', live: null, who };
    return { state: live.archived ? 'archived' : live.sleeping ? 'asleep' : 'awake', live, who };
}
export const STATE_WORD = { awake: 'Awake', asleep: 'Asleep', archived: 'Archived' };
/** The one line that explains an inactive agent, as the approved mock words it. */
export const stateLine = (who, st) => st === 'asleep' ? `${who} is asleep — it won’t read your changes request until woken.` : st === 'archived' ? `${who} is archived — archived agents don’t wake automatically. Start it or hand this off on the board.` : '';

/** The row's Wake (asleep) or Start agent (archived) button; null for an awake or unknown agent. */
export function wakeButton(ws) {
    if (ws.state !== 'asleep' && ws.state !== 'archived') return null;
    const label = ws.state === 'asleep' ? 'Wake' : 'Start agent', b = el('button', `btn btn-small inbox-wake inbox-wake-${ws.state}`, label); b.type = 'button'; b.dataset.slot = 'wake';
    b.setAttribute('aria-label', `${label} ${markHidden(ws.who, { strict: true })}`);
    b.addEventListener('click', () => { b.disabled = true; importOnce('./agent_actions.js').then(m => (ws.state === 'asleep' ? m.toggleAgentSleep(ws.live.name, ws.live.agent_type, ws.live.session_id, 'wake') : m.toggleAgentArchive(ws.live.name, ws.live.agent_type, ws.live.session_id, 'unarchive'))).catch(() => {}).finally(() => { b.disabled = false; document.dispatchEvent(new CustomEvent('coral:needs-updated')); }); });
    return b;
}

/** What the row's line adds after "Sent back · waiting on X": the agent's state word, and for an inactive agent the sentence of what that means. */
export function stateNodes(review) {
    const ws = agentWaitState(review);
    if (!ws.state) return [];
    const word = el('span', `inbox-wait-state inbox-wait-${ws.state}`, STATE_WORD[ws.state]);
    const line = stateLine(markHidden(ws.who || 'The agent', { strict: true }), ws.state);
    return line ? [word, el('span', `inbox-wait-line inbox-wait-${ws.state}`, line)] : [word];
}
