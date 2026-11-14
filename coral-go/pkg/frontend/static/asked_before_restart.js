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

/** Whether the Operator hid this agent's open request from Needs you (#11946): the machine keeps it, per agent and request (the row says wait_ignored), so the page, the tab's number and the phone push agree; the agent's next request is not hidden by it. */
export const waitIgnored = s => !!(s && s.wait_ignored);

/* Dismiss never answers a live terminal: retain the active wait until the agent clears it (#14152). */
/** An awake agent that holds a task in progress and has taken no turn for the server's bound (#16921): { id, title, since }. Stopped by the person, crashed, out of limit: it is not working, so it needs the person. Strings only: payloads are untrusted. */
export function stalledOf(s) {
    const t = s && !s.sleeping && !s.archived && s.stalled_task;
    const id = t && typeof t === 'object' ? Number(t.task_id) : 0;
    if (!Number.isSafeInteger(id) || id < 1) return null;
    return { id, title: typeof t.title === 'string' ? t.title : '', since: typeof t.since === 'string' ? t.since : '' };
}

export const needsYou = s => (!!s && !s.sleeping && !s.archived && !s.wait_removed && needsInputAttention(s)) || !!askedBefore(s) || !!stalledOf(s);

/** The words that open what it asked: "before Coral restarted" when Coral's stop put it to sleep, else "before it went to sleep" (an operator's Sleep, an ended CLI). */
export const askedWords = a => `Asked ${a && a.after_restart ? 'before Coral restarted' : 'before it went to sleep'}: ${a ? a.text : ''}`;

/** The row as Needs you shows it: an agent that asked before the restart carries its words, kind and time as a waiting agent's do. */
export function askedRow(s) {
    if (s.waiting_for_input && waitIgnored(s) && !s.sleeping && !s.archived) return { ...s, waiting_summary: `Still waiting in its terminal. ${s.waiting_summary || "Open the agent to continue."}` };
    if (dialogDue(s) && !s.waiting_summary) { const d = dialogOf(s); return { ...s, waiting_summary: DIALOG_WORDS, waiting_kind: 'dialog', waiting_since: new Date(d.since).toISOString() }; } // at a dialog for the set minutes (#11430)
    const st = stalledOf(s);
    if (st) return { ...s, waiting_summary: `Stopped with task #${st.id} in progress`, waiting_kind: 'stalled', waiting_since: st.since || undefined };
    const a = askedBefore(s);
    return a ? { ...s, waiting_summary: askedWords(a), waiting_kind: a.kind, waiting_since: a.at } : s;
}
