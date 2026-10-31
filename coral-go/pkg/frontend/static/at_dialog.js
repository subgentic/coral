/* An agent at a blocking dialog (#11430, coral-hub's #139004: an agent sat on Claude Code's "trust this folder" prompt for four hours and the row said Idle while five pieces of work queued behind it).
 * Coral's screen parser already knows the prompt (a trust-this-folder screen is in the captured corpus): when it holds a board message back for one, the live row carries
 * skipped_send { why: "a prompt is open: ...", since } (waiting.js). A row whose agent is not asking through its own hook, with that skip standing, is AT A DIALOG: its state is "At a dialog", not Idle, and after
 * DIALOG_AFTER_MIN minutes it is a Needs you item ("needs one click") with the alert the other needs-you items have. A server that sends the dialog itself, whether or not anything is queued behind it, says so in
 * the row's at_dialog { since } and that wins (the same words). No imports: the state table and the Needs you test both read it. */

/** Minutes at a dialog before it needs the person (the team's setting once the server sends one; coral-hub asked for 5). */
export const DIALOG_AFTER_MIN = 5;

const PROMPT_SKIP = 'a prompt is open'; // ptymanager.SkipPrompt, the reason's start

/** { since (ms or 0) } while the row's agent stands at a dialog Coral saw on its screen, else null. Strings only: payloads are untrusted. */
export function dialogOf(row) {
    if (!row || row.sleeping || row.waiting_for_input) return null; // asleep, or asking through its own hook (its own state says so)
    const own = row.at_dialog;
    if (own && typeof own === 'object') { const t = Date.parse(own.since); return { since: Number.isFinite(t) ? t : 0 }; }
    const k = row.skipped_send;
    if (!k || typeof k.why !== 'string' || !k.why.toLowerCase().startsWith(PROMPT_SKIP)) return null;
    const t = Date.parse(k.since);
    return { since: Number.isFinite(t) ? t : 0 };
}

/** The dialog has stood for the set minutes: the agent needs one click and is a Needs you item. A dialog with no known start is not counted (no guess). */
export function dialogDue(row, now = Date.now(), afterMin = DIALOG_AFTER_MIN) {
    const d = dialogOf(row);
    return !!d && d.since > 0 && now - d.since >= afterMin * 60000;
}

/** What Needs you says for it. */
export const DIALOG_WORDS = 'Needs one click: it is at a dialog';
