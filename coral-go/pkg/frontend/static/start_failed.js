/* An agent whose start was refused because its CLI is missing or can't be run (#353): the server records why in start_failure (a fixed code) apart from the sleep reason, and sends the one fixed
   sentence for that code in start_failure_text ("failed to start: the Codex CLI was not found. Set Settings > CLI paths > Codex to its codex.exe."). The page picks nothing itself: it writes that
   sentence as text (textContent, never markup), after the agent's own name, so the server and the page cannot say different things. */

const REASONS = new Set(['cli_missing', 'cli_untrusted_mount', 'cli_path_unusable']);
const MAX_WORDS = 300;
const FALLBACK = 'failed to start: its CLI is missing or can’t be run. Set its path in Settings > CLI paths.';

/** True for a sleeping, not archived agent whose start was refused for its CLI. */
export function isStartFailed(row) {
    return !!row && !!row.sleeping && !row.archived && REASONS.has(row.start_failure);
}

/** The sentence for a failed-start row: the server's, bounded, or a plain one when an older server sent none. */
export function startFailedSentence(row) {
    const t = row && typeof row.start_failure_text === 'string' ? row.start_failure_text.trim() : '';
    return (t || FALLBACK).slice(0, MAX_WORDS);
}

/** "<who> failed to start: ..." for the composer's status line. */
export function startFailedText(who, row) {
    return `${who} ${startFailedSentence(row)}`;
}
