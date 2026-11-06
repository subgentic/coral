/* A skill waiting for the Operator's approval is an item of the Inbox's Needs you (#12139, goal #191): one row for each, from the Skills Store's own list (this computer only: the Hub has no such route). A row says
 * which skill and who published it (the agent and team from the session) and opens the Skills tab at that skill. */
// Only the no-import gap module: inbox_tab.js sums the count at load, and a module this one imported could be loading it (a circle left the count uninitialised).
const LOCAL_SERVER = 'local';
import { readOutcome as gap } from './needs_incomplete.js';

let pending = [], hubCount = null;

/** Read the skills that wait. On a computer: GET /api/skills?status=pending. Through a Hub (#13841): one read of GET /api/needs-you?kind=skill gives the rows and the count of every skill waiting, shown as plain text
 *  with "approve at the computer" and no buttons (the Hub cannot approve one). A refused or missing route, or a failed read, is not "no skills": the rows stay as they were and the Inbox says not everything is shown
 *  (needs_incomplete.js); only a 200 with an empty list is nothing waiting. */
export async function loadPendingSkills({ hub = false } = {}) {
    if (hub) {
        try {
            const r = await fetch('/api/needs-you?kind=skill');
            if (!r.ok) { gap('skills', 'hub', false); if (r.status === 401 || r.status === 403) { pending = []; hubCount = 0; } return pending; } // access taken away: none drawn, and the note says so
            const d = await r.json();
            if (!d || !Array.isArray(d.items)) { gap('skills', 'hub', false); return pending; } // not a list: not "nothing waiting"
            const items = d.items;
            pending = items.filter(i => i && i.kind === 'skill' && typeof i.id === 'string').map(i => ({ id: i.id, hub: true, line: String(i.line || ''), publisher_agent: i.from || '', publisher_team: i.team || '', created_at: i.at || '' }));
            const n = Number(d && d.counts && d.counts.skill);
            hubCount = Number.isFinite(n) && n >= pending.length ? n : pending.length;
            gap('skills', 'hub', true);
        } catch { gap('skills', 'hub', false); }
        return pending;
    }
    hubCount = null;
    try { const r = await fetch('/api/skills?status=pending'); if (!r.ok) { gap('skills', 'local', false); if (r.status === 401 || r.status === 403) pending = []; } else { const got = (await r.json()).skills; if (Array.isArray(got)) { pending = got; gap('skills', 'local', true); } else gap('skills', 'local', false); } } catch { gap('skills', 'local', false); }
    return pending;
}

/** Words an agent chose, as one line the Operator can trust (#12260): every control, zero-width and reordering character is written out as <U+202E>, never passed to the page (a name with a right-to-left override could read as another word, and
 *  this row is where the Operator decides). Written here, not imported: this module has no imports (see the top). */
const marked = t => String(t == null ? '' : t).replace(/[\p{Cc}\p{Cf}]/gu, c => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`).replace(/\s+/g, ' ').trim();
const who = r => `${marked(r.publisher_agent) || 'An agent'}${r.publisher_team ? ' · ' + marked(r.publisher_team) : ''}`;

/** The rows Needs you draws, in the shape of the other items. */
export const skillRows = () => pending.map(r => ({
    skillReview: r, session_id: `skill_review:${String(r.id).replace(/^skill:/, '')}`, display_name: marked(r.hub ? r.line : r.name), board_project: marked(r.publisher_team), server: LOCAL_SERVER, waiting_kind: 'skill_review',
    waiting_summary: r.hub ? `Published by ${who(r)} · approve at the computer` : `Published by ${who(r)}${r.has_scripts || r.not_reviewable ? ' · has files to review' : ''}`, waiting_since: r.created_at,
}));

/** The skill's name as a line the Operator can trust (hidden characters written out). */
export const skillName = r => marked(r.hub ? r.line : r.name);
export const skillLine = r => r.hub ? marked(r.line) : `Skill to approve: ${marked(r.name)} version ${r.version}`;
export const skillCount = () => (hubCount === null ? pending.length : hubCount);

/** Open the skill's approval view in the Skills tab. */
export const openSkill = r => { if (r.hub) return; window.switchNavTab?.('skills', { skillId: r.id }); };
