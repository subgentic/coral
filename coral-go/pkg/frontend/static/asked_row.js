/* The row as Needs you shows it (askedRow, moved out of asked_before_restart.js, #18010): only the Inbox's table and the screen reader's announcement draw rows, so the start path keeps the one-line needsYou test and
 * this loads with the Inbox (importOnce). The announcement in inbox_tab.js takes its words from here, and says nothing when this module does not load (its .catch). */
import { waitIgnored, askedBefore, askedWords } from './asked_before_restart.js';
import { dialogOf, dialogDue, DIALOG_WORDS } from './at_dialog.js';

/** An awake agent that holds a task in progress and has taken no turn for the server's bound (#16921): { id, title, since }, by the same reading of the id as needsYou's count (a positive safe integer, a number, not a string; a test sweeps odd payloads through both). Stopped by the person, crashed, out of limit: it is not working, so it needs the person. Strings only: payloads are untrusted. */
export function stalledOf(s) {
    const t = s && !s.sleeping && !s.archived && s.stalled_task;
    const id = t?.task_id;
    if (!(Number.isSafeInteger(id) && id > 0)) return null;
    return { id, title: typeof t.title === 'string' ? t.title : '', since: typeof t.since === 'string' ? t.since : '' };
}

/** The row as Needs you shows it: an agent that asked before the restart carries its words, kind and time as a waiting agent's do. */
export function askedRow(s) {
    if (s.waiting_for_input && waitIgnored(s) && !s.sleeping && !s.archived) return { ...s, waiting_summary: `Still waiting in its terminal. ${s.waiting_summary || "Open the agent to continue."}` };
    if (dialogDue(s) && !s.waiting_summary) { const d = dialogOf(s); return { ...s, waiting_summary: DIALOG_WORDS, waiting_kind: 'dialog', waiting_since: new Date(d.since).toISOString() }; } // at a dialog for the set minutes (#11430)
    const st = stalledOf(s); // the words are built here from the validated id, never taken from the payload (an older or linked Coral sends none, and a payload is untrusted)
    if (st) return { ...s, waiting_summary: `Idle with task #${st.id} in progress`, waiting_kind: 'stalled', waiting_since: st.since || undefined };
    const a = askedBefore(s);
    return a ? { ...s, waiting_summary: askedWords(a), waiting_kind: a.kind, waiting_since: a.at } : s;
}
