// The Orchestrator access group's pure words (#11432), apart from the group so a unit test can read them without a browser.
export const OG_KEYS = ['og_enabled', 'og_seat', 'og_max_per_hour', 'og_max_live', 'og_idle_minutes'];
const KIND_WORDS = { launch: 'started', wake: 'woke', sleep: 'put to sleep', grant: 'setting changed' };

/** The session id a board member's session name carries (the part after the agent type: "claude-<id>"). */
export const seatOfName = name => { const i = String(name || '').indexOf('-'); return i >= 0 ? String(name).slice(i + 1) : ''; };

/** The seat the form offers when none was ever saved (#14998): the team's one Orchestrator (a member whose job title or name says orchestrator, the server's own test), as its session id; '' when there is none or more than one
 * (the person picks). Only what the form shows: nothing is granted until the Operator turns the switch on and saves, and the server takes the seat only from that save. */
export function defaultSeat(members) {
    const ids = [];
    for (const m of members || []) {
        if (!m || /^terminal-/.test(m.session_name || '') || m.subscriber_id === 'Operator') continue;
        const id = seatOfName(m.session_name);
        if (id && /orchestrator/i.test(`${m.subscriber_id || ''} ${m.job_title || ''}`) && !ids.includes(id)) ids.push(id);
    }
    return ids.length === 1 ? ids[0] : '';
}

/** The log's own sentence for one row: who, what, to whom, how it went. The words are the server's cleaned names, set as text. */
export function logLine(e) {
    const what = KIND_WORDS[e.kind] || 'did something to';
    const who = e.actor || 'An agent';
    const state = e.status === 'failed' ? ' (failed)' : e.status === 'reserved' ? ' (in progress)' : '';
    return e.kind === 'grant' ? `${who}: ${what}: ${e.target}` : `${who} ${what} ${e.target}${state}`;
}
