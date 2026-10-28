/* What an agent asked before Coral restarted (#10368, Mobile #10360). A restart of Coral ends a pty agent's CLI, and the question, permission or plan it was waiting on went with it: Needs you emptied and the chat
 * showed only the sent line. The server keeps the request in the agent's events and says it on the sleeping agent's row (asked_before_restart: {text, kind, at}). The CLI that asked is gone, so nothing can
 * answer it: Needs you lists the agent with the words "Asked before Coral restarted: <what>", and the chat says the same with Restart and Dismiss. Dismissing is this browser's: it is kept per agent and request. */
import { needsInputAttention } from './display_activity_hint.js';
import { browserLocal } from './safe_storage.js';

const KEY = 'coral-asked-dismissed';
const read = () => { try { return JSON.parse(browserLocal.get(KEY) || '{}') || {}; } catch { return {}; } };

/** The open request a sleeping agent had when it went away, or null (awake, archived, none, or dismissed). */
export function askedBefore(s) {
    const a = s && s.sleeping && !s.archived && s.asked_before_restart;
    if (!a || !a.text) return null;
    return read()[s.session_id] === a.at ? null : a;
}

/** Dismiss it for this agent's request: it leaves Needs you and the chat. */
export function dismissAsked(s) {
    const a = s && s.asked_before_restart;
    if (!a) return;
    try { const all = read(); all[s.session_id] = a.at; browserLocal.set(KEY, JSON.stringify(all)); } catch { /* it stays until the page is reloaded */ }
    document.dispatchEvent(new CustomEvent('coral:asked-dismissed', { detail: { sessionId: s.session_id } }));
}

/** Does Needs you list this agent: it waits for its person, or it asked something before Coral restarted. */
export const needsYou = s => needsInputAttention(s) || !!askedBefore(s);

/** The words that open what it asked: "before Coral restarted" when Coral's stop put it to sleep, else "before it went to sleep" (an operator's Sleep, an ended CLI). */
export const askedWords = a => `Asked ${a && a.after_restart ? 'before Coral restarted' : 'before it went to sleep'}: ${a ? a.text : ''}`;

/** The row as Needs you shows it: an agent that asked before the restart carries its words, kind and time as a waiting agent's do. */
export function askedRow(s) {
    const a = askedBefore(s);
    return a ? { ...s, waiting_summary: askedWords(a), waiting_kind: a.kind, waiting_since: a.at } : s;
}
