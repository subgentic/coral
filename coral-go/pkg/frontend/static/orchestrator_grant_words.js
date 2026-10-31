// The Orchestrator access group's pure words (#11432), apart from the group so a unit test can read them without a browser.
export const OG_KEYS = ['og_enabled', 'og_seat', 'og_max_per_hour', 'og_max_live', 'og_idle_minutes'];
const KIND_WORDS = { launch: 'started', wake: 'woke', sleep: 'put to sleep', grant: 'setting changed' };

/** The session id a board member's session name carries (the part after the agent type: "claude-<id>"). */
export const seatOfName = name => { const i = String(name || '').indexOf('-'); return i >= 0 ? String(name).slice(i + 1) : ''; };

/** The log's own sentence for one row: who, what, to whom, how it went. The words are the server's cleaned names, set as text. */
export function logLine(e) {
    const what = KIND_WORDS[e.kind] || 'did something to';
    const who = e.actor || 'An agent';
    const state = e.status === 'failed' ? ' (failed)' : e.status === 'reserved' ? ' (in progress)' : '';
    return e.kind === 'grant' ? `${who}: ${what}: ${e.target}` : `${who} ${what} ${e.target}${state}`;
}
