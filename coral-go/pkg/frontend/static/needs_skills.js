/* A skill waiting for the Operator's approval is an item of the Inbox's Needs you (#12139, goal #191): one row for each, from the Skills Store's own list (this computer only: the Hub has no such route). A row says
 * which skill and who published it (the agent and team from the session) and opens the Skills tab at that skill. */
// No imports: inbox_tab.js sums the count at load, and a module this one imported could be loading it (a circle left the count uninitialised).
const LOCAL_SERVER = 'local';

let pending = [];

/** Read the skills that wait (GET /api/skills?status=pending). Where the route is not there (the Hub's Inbox, an older Coral) there are none. */
export async function loadPendingSkills() {
    try { const r = await fetch('/api/skills?status=pending'); pending = r.ok ? ((await r.json()).skills || []) : []; } catch { pending = []; }
    return pending;
}

/** Words an agent chose, as one line the Operator can trust (#12260): every control, zero-width and reordering character is written out as <U+202E>, never passed to the page (a name with a right-to-left override could read as another word, and
 *  this row is where the Operator decides). Written here, not imported: this module has no imports (see the top). */
const marked = t => String(t == null ? '' : t).replace(/[\p{Cc}\p{Cf}]/gu, c => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`).replace(/\s+/g, ' ').trim();
const who = r => `${marked(r.publisher_agent) || 'An agent'}${r.publisher_team ? ' · ' + marked(r.publisher_team) : ''}`;

/** The rows Needs you draws, in the shape of the other items. */
export const skillRows = () => pending.map(r => ({
    skillReview: r, session_id: `skill_review:${r.id}`, display_name: marked(r.name), board_project: marked(r.publisher_team), server: LOCAL_SERVER, waiting_kind: 'skill_review',
    waiting_summary: `Published by ${who(r)}${r.has_scripts || r.not_reviewable ? ' · has files to review' : ''}`, waiting_since: r.created_at,
}));

/** The skill's name as a line the Operator can trust (hidden characters written out). */
export const skillName = r => marked(r.name);
export const skillLine = r => `Skill to approve: ${marked(r.name)} version ${r.version}`;
export const skillCount = () => pending.length;

/** Open the skill's approval view in the Skills tab. */
export const openSkill = r => { window.switchNavTab?.('skills', { skillId: r.id }); };
