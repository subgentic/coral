/* The row as Needs you shows it (askedRow, moved out of asked_before_restart.js, #18010): only the Inbox's table and the screen reader's announcement draw rows, so the start path keeps the one-line needsYou test and
 * this loads with the Inbox (importOnce). */
import { waitIgnored, askedBefore, askedWords } from './asked_before_restart.js';
import { dialogOf, dialogDue, DIALOG_WORDS } from './at_dialog.js';

/** The row as Needs you shows it: an agent that asked before the restart carries its words, kind and time as a waiting agent's do. */
export function askedRow(s) {
    if (s.waiting_for_input && waitIgnored(s) && !s.sleeping && !s.archived) return { ...s, waiting_summary: `Still waiting in its terminal. ${s.waiting_summary || "Open the agent to continue."}` };
    if (dialogDue(s) && !s.waiting_summary) { const d = dialogOf(s); return { ...s, waiting_summary: DIALOG_WORDS, waiting_kind: 'dialog', waiting_since: new Date(d.since).toISOString() }; } // at a dialog for the set minutes (#11430)
    const t = !s.sleeping && !s.archived && s.stalled_task;
    if (t) return { ...s, waiting_summary: t.words, waiting_kind: 'stalled', waiting_since: t.since }; // the server's words: "Stopped with task #3 in progress"
    const a = askedBefore(s);
    return a ? { ...s, waiting_summary: askedWords(a), waiting_kind: a.kind, waiting_since: a.at } : s;
}
