/* What an agent asked before Coral restarted (#10368, Mobile #10360). A restart of Coral ends a pty agent's CLI, and the question, permission or plan it was waiting on went with it: Needs you emptied and the chat
 * showed only the sent line. The server keeps the request in the agent's events and says it on the sleeping agent's row (asked_before_restart: {text, kind, at}). The CLI that asked is gone, so nothing can
 * answer it: Needs you lists the agent with the words "Asked before Coral restarted: <what>", and the chat says the same with Restart and Dismiss. Dismissing is this browser's: it is kept per agent and request. */
import { needsInputAttention } from './display_activity_hint.js';
import { browserLocal } from './safe_storage.js';
import { dialogOf, dialogDue, DIALOG_WORDS } from './at_dialog.js';

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

const IGNORED_KEY = 'coral-waits-ignored';
const readIgnored = () => { try { return JSON.parse(browserLocal.get(IGNORED_KEY) || '{}') || {}; } catch { return {}; } };
/** What identifies one request of an agent: when it began, else its words, else its kind: a new request is a new key. */
export const waitKey = s => String((s && (s.waiting_since || s.waiting_summary || s.waiting_kind)) || '');
/** Whether the Operator hid this agent's open request from Needs you (#11946): kept per agent and request in this browser, so the agent's next request is shown. */
export const waitIgnored = s => !!(s && s.session_id) && readIgnored()[s.session_id] === waitKey(s);
/** Hide this agent's open request from Needs you and its count; nothing is sent to the agent and its own state is not touched. It comes back with the agent's next request. */
export function ignoreWait(s) {
    if (!s || !s.session_id) return;
    try { const all = readIgnored(); all[s.session_id] = waitKey(s); const keys = Object.keys(all); if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete all[k]; browserLocal.set(IGNORED_KEY, JSON.stringify(all)); } catch { /* it stays until the page is reloaded */ }
    document.dispatchEvent(new CustomEvent('coral:asked-dismissed', { detail: { sessionId: s.session_id } }));
}

/** Does Needs you list this agent: it waits for its person (and the person has not hidden that request), or it asked something before Coral restarted. */
export const needsYou = s => (needsInputAttention(s) && !waitIgnored(s)) || !!askedBefore(s);

/** The words that open what it asked: "before Coral restarted" when Coral's stop put it to sleep, else "before it went to sleep" (an operator's Sleep, an ended CLI). */
export const askedWords = a => `Asked ${a && a.after_restart ? 'before Coral restarted' : 'before it went to sleep'}: ${a ? a.text : ''}`;

/** The row as Needs you shows it: an agent that asked before the restart carries its words, kind and time as a waiting agent's do. */
export function askedRow(s) {
    if (dialogDue(s) && !s.waiting_summary) { const d = dialogOf(s); return { ...s, waiting_summary: DIALOG_WORDS, waiting_kind: 'dialog', waiting_since: new Date(d.since).toISOString() }; } // at a dialog for the set minutes (#11430)
    const a = askedBefore(s);
    return a ? { ...s, waiting_summary: askedWords(a), waiting_kind: a.kind, waiting_since: a.at } : s;
}
