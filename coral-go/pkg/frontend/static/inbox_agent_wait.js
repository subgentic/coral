/* Waiting on an agent (#19904, the approved two-tab mock): what a row on that tab says about the agent it waits on, and what the Operator can do about it. The agent is Awake, Asleep or Archived (the three states of #19673):
 * an awake one works on it (quiet actions: Open file, Open agent); an asleep one will not read the request until it is woken (amber, Wake); an archived one does not wake by itself (rose, Start agent). Pure reading of the live list;
 * the two buttons are the Agents list's own wake and unarchive, so the agent ends up in the state the Agents tab shows. Built with textContent only. */
import { state } from './state.js';
import { sessionServer, serverFetch } from './server_base.js';
import { showToast } from './utils.js';
import { liveAgentOf } from './agent_live.js';
import { markHidden } from './visible_marks.js';
import { importOnce } from './import_once.js';
import { el } from './dom_el.js';
import { toggleAgentSleep, toggleAgentArchive } from './agent_actions.js';
const { waitingOnAgent } = await importOnce('./inbox_review_state.js'), { shortWait } = await importOnce('./waiting_text.js');
/** A sent-back file the agent has not answered: the one that waits on the agent. A reply (new comments) brings it back to the Operator, and to the Waiting on you tab (#19904). */
export const stillWaitingOnAgent = row => waitingOnAgent(row) && !(row?.new_comments > 0);

/** The agent a sent-back file waits on: its live row (by the file's session, else by name on its team) and its state: 'awake', 'asleep', 'archived', or '' when Coral does not list it. */
export function agentWaitState(review) {
    const who = String(review?.produced_by || '');
    const live = (state.liveSessions || []).find(s => review?.session_id && s.session_id === review.session_id) || liveAgentOf(who, { board: review?.team ? String(review.team).split(':').pop() : '', session: review?.session_id || '' }) || null;
    if (!live) return { state: '', live: null, who };
    return { state: live.archived ? 'archived' : live.sleeping ? 'asleep' : 'awake', live, who };
}
export const STATE_WORD = { awake: 'Awake', asleep: 'Asleep', archived: 'Archived' };
/** An answer or a comment wakes a sleeping, not archived, agent (#19897, #19901): for those rows the line says it is being woken and there is no Wake button. */
const WAKES = { answered_ask: 'your answer', comment_sent: 'your comment' };
/** The one line that explains an inactive agent, as the approved mock words it. */
export const stateLine = (who, st, kind = '') => st === 'asleep' ? (WAKES[kind] ? `${who} is asleep — ${WAKES[kind]} is waking it.` : `${who} is asleep — it won’t read your changes request until woken.`) : st === 'archived' ? `${who} is archived — archived agents don’t wake automatically. Start it or hand this off on the board.` : '';

/** The row's Wake (asleep) or Start agent (archived) button; null for an awake or unknown agent. */
export function wakeButton(ws, kind = '') {
    if ((ws.state !== 'asleep' || WAKES[kind]) && ws.state !== 'archived') return null; // an asleep agent that an answer or a comment wakes needs no button
    const label = ws.state === 'asleep' ? 'Wake' : 'Start agent', b = el('button', `btn btn-small inbox-wake inbox-wake-${ws.state}`, label); b.type = 'button'; b.dataset.slot = 'wake';
    b.setAttribute('aria-label', `${label} ${markHidden(ws.who, { strict: true })}`);
    b.addEventListener('click', () => { b.disabled = true; Promise.resolve().then(() => (ws.state === 'asleep' ? toggleAgentSleep(ws.live.name, ws.live.agent_type, ws.live.session_id, 'wake') : toggleAgentArchive(ws.live.name, ws.live.agent_type, ws.live.session_id, 'unarchive'))).catch(() => {}).finally(() => { b.disabled = false; document.dispatchEvent(new CustomEvent('coral:needs-updated')); }); });
    return b;
}

/** The agent's state as the mock's chip: a dot and "Awake · working", "Awake", "Asleep" or "Archived". null when Coral does not list the agent. */
export function stateChip(review) {
    const ws = agentWaitState(review);
    if (!ws.state) return null;
    const chip = el('span', `inbox-wait-state inbox-wait-${ws.state}`);
    chip.append(el('span', 'inbox-st-dot', ''), STATE_WORD[ws.state] + (ws.state === 'awake' && ws.live?.working ? ' \u00b7 working' : ''));
    return chip;
}
/** "Waiting on X": the words after the Sent back chip, the agent in bold (the mock's meta line). `agent` is the agent's name or link node. */
export const waitTarget = agent => { const t = el('span', 'inbox-wait-target', 'Waiting on '); t.append(agent); return t; };

/** What the row's line adds after the chip: the agent's state chip (unless the caller put it in the meta line) and, for an inactive agent, the sentence of what that means. */
export function stateNodes(review, kind = '', withChip = true) {
    const chip = stateChip(review);
    if (!chip) return [];
    const ws = agentWaitState(review), line = stateLine(markHidden(ws.who || 'The agent', { strict: true }), ws.state, kind);
    return [...(withChip ? [chip] : []), ...(line ? [el('span', `inbox-wait-line inbox-wait-${ws.state}`, line)] : [])];
}

const cutName = s => { s = String(s); return s.length > 80 ? `${s.slice(0, 79)}\u2026` : s; }; // a long file name is cut at about 80 characters in the text sent to the agent
const NUDGE = file => `A reminder from the Operator: they are waiting on your new version of ${file}. Please upload it, or say on the board what is in the way.`;
/** Send the awake agent the reminder, through its own send route (the one Continue uses); the Operator hears whether it went. */
export async function nudge(row, ws) {
    const live = ws.live; if (!live) return;
    try {
        const resp = await serverFetch(sessionServer(live), `/api/sessions/live/${encodeURIComponent(live.name)}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: NUDGE(cutName(row.name || row.title || (row.artifact && row.artifact.name) || 'what you asked')), agent_type: live.agent_type, session_id: live.session_id }) });
        const result = resp.ok ? await resp.json().catch(() => ({})) : { error: 'not sent' };
        if (result.error) throw new Error(result.error);
        showToast(result.held ? 'Held until the agent\u2019s question is answered.' : `Nudge sent to ${ws.who}.`);
    } catch { showToast('The nudge was not sent. Check the connection.', true); }
}

/** The More-menu items of a row on this tab (the mock): an awake agent can be nudged or given another note; an inactive one is dealt with on its team's board. */
export function menuItems(row, ws, { addNote, openBoard }) {
    const who = markHidden(ws.who || 'the agent', { strict: true });
    if (ws.state === 'awake') return [{ label: `Nudge ${who}`, title: 'Send the agent a reminder that you are waiting', run: () => nudge(row, ws) }, ...(addNote ? [{ label: 'Add another note', title: 'Send one more request for changes', run: addNote }] : [])];
    if (ws.state === 'asleep') return [{ label: 'Reassign on board', title: 'Open the team board to give the work to another agent', run: openBoard }];
    if (ws.state === 'archived') return [{ label: 'Hand off on board', title: 'Open the team board to hand this off', run: openBoard }];
    return [];
}

const CHIP = { awake: 'inbox-st-chip inbox-st-awake', asleep: 'inbox-st-chip inbox-st-asleep', archived: 'inbox-st-chip inbox-st-archived' };
/** The tab's one line above the list, as the mock has it: the count, then each agent state with its coloured dot, then how rows clear. */
export function statusNode(total, n) {
    const box = el('span', 'inbox-agent-status'), say = (cls, text) => el('span', cls, text), dot = () => say('inbox-st-dot', '');
    box.append(el('strong', null, `${total} waiting on an agent`));
    const inactive = (n.asleep || 0) + (n.archived || 0); box.append(el('strong', 'inbox-st-short', `${total} waiting${inactive ? ` \u00b7 ${inactive} inactive` : ''}`)); // a phone's line, as the mock has it: one short line instead of the long one
    for (const k of ['awake', 'asleep', 'archived']) if (n[k]) { const chip = el('span', CHIP[k]); chip.append(dot(), `${n[k]} ${k}`); box.append(say('inbox-st-sep', '\u00b7'), chip); }
    box.append(say('inbox-st-sep', '\u00b7'), say('inbox-st-rest', 'Longest waiting first \u00b7 rows clear automatically once the agent acts'));
    return box;
}

/** Group by Agent: the heading's right side, as the mock has it: "1 waiting · since 3 h ago" and, where nothing else wakes the agent, Wake or Start agent. `info` is { count, since, ws, wake }. Called from a row's decorate, so it runs again whenever the rows are drawn. */
export function decorateGroupHead(tr, info) {
    let head = tr.previousElementSibling; while (head && !head.classList.contains('dt-group')) head = head.previousElementSibling;
    const th = head && head.querySelector('th'); if (!th || th.querySelector('.inbox-group-right')) return;
    const right = el('span', 'inbox-group-right'), since = shortWait(info.since);
    right.append(el('span', 'inbox-group-meta', `${info.count} waiting${since ? ` \u00b7 since ${since} ago` : ''}`));
    const wake = info.wake ? wakeButton(info.ws) : null;
    if (wake) { wake.textContent = info.ws.state === 'asleep' ? `Wake ${markHidden(info.ws.who, { strict: true })}` : 'Start agent'; right.append(wake); }
    th.classList.add('inbox-group-flex'); th.append(right);
}
/** The line under Waiting on you's filters: how many are unread, how many are listed, and how many wait on an agent on the other tab. */
export const statusLine = (unread, listed) => listed ? `${unread} unread, ${listed} in the list` : '';
