/* Skills in New agent and New team (#12104, goal #191): an optional list of the skills the Operator approved, ticked one or more; the launch then carries their ids and the server tells the agent which skills apply
 * and how to load them (the launch note). Only this computer's approved skills are offered, so the row is hidden for another computer and when there are none. Everything a skill says is drawn with textContent. */
import { loadStyles } from './lazy_styles.js';
import { requestJson } from './api.js';
await loadStyles('skills.css');

const SKILLS_STAY = 'Skills stay on the computer: open New agent from its own Coral to choose one.'; // the @skill row's pattern (skill_mention.js)
const MAX = 10; // the server's limit for one launch
const picked = new Map(); // row id -> Set of skill ids
const generation = new Map(); // row id -> the latest mount: an answer that arrives after a newer mount began is dropped

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The newest version of each skill by name, in the order the names first appear: an older version of a skill the person can pick is not another thing to choose. */
function newestOnly(list) {
    const best = new Map();
    for (const s of list) { const have = best.get(s.name); if (!have || Number(s.version) > Number(have.version)) best.set(s.name, s); }
    return [...best.values()];
}

/** The ids ticked in the row ('launch-skills' or 'team-skills'), none when the row is hidden. */
export function launchSkillIds(rowId) {
    const row = document.getElementById(`${rowId}-row`);
    return row && !row.hidden ? [...(picked.get(rowId) || [])] : [];
}

/** The ids a team member has of its own (#18657): what its Edit member dialog was opened with, changed by the ticks. Unlike launchSkillIds it does not go empty when the row is hidden or says the
 *  skills could not be read: a member saved then keeps the skills it had. The team's own skills are not in it. */
export function memberSkillIds() { return [...(picked.get('launch-skills') || [])]; }

/** Draw the row: the approved skills with a tick each. local is false for another computer's launch (its skills are its own: not offered here).
 *  opts (a team member's Edit member, #18657): initial is the member's own ids, ticked at the start; fromTeam is the ids the team gives every member, shown ticked and fixed as "from the team"
 *  and never counted as the member's own. */
export async function mountLaunchSkills(rowId, local, opts = {}) {
    if (typeof opts === 'string') opts = { selectedName: opts }; // a skill named by a link ticks at the start
    const selectedName = opts.selectedName || '';
    const row = document.getElementById(`${rowId}-row`), host = document.getElementById(`${rowId}-host`);
    if (!row || !host) return;
    const mine = (generation.get(rowId) || 0) + 1; generation.set(rowId, mine);
    const initial = Array.isArray(opts.initial) ? opts.initial.filter(id => typeof id === 'string') : [], team = new Set(Array.isArray(opts.fromTeam) ? opts.fromTeam : []);
    picked.set(rowId, new Set(initial.filter(id => !team.has(id)))); // kept when the list cannot be read: a member saved then keeps its skills
    row.hidden = true; host.replaceChildren();
    const say = words => { row.hidden = false; host.replaceChildren(el('p', 'skills-note skills-unavailable', words)); }; // a row that says why, not a row that is missing (#13871)
    if (!local) { say(SKILLS_STAY); return; } // another computer's launch, or through the Hub: its skills are its own, and the Hub has no list to read
    let list = [];
    try { list = (await requestJson('GET', '/api/skills?status=approved')).skills; } catch { if (generation.get(rowId) === mine) say('Skills could not be read from this computer, so none can be chosen now.'); return; }
    if (!Array.isArray(list)) { if (generation.get(rowId) === mine) say('Skills could not be read from this computer, so none can be chosen now.'); return; }
    list = newestOnly(list); // one row per skill, its newest approved version (#15890: using-coral v1, v2 and v3 were three rows)
    if (!list.length || generation.get(rowId) !== mine) return;
    const chosen = picked.get(rowId);
    for (const id of [...chosen]) if (!list.some(s => s.id === id)) chosen.delete(id); // a skill that is no longer approved is not kept
    const search = el('input', 'skills-pick-search'); search.type = 'search'; search.placeholder = 'Search skills'; search.setAttribute('aria-label', 'Search skills');
    const note = el('p', 'skills-note');
    const more = el('details', 'skills-pick-more'), summary = el('summary', 'skills-pick-summary'); // closed: an optional list does not push the dialog's buttons off a short window (#12495)
    const ul = el('ul', 'skills-pick-list');
    const rows = list.map(s => {
        const li = el('li', 'skills-pick'), label = el('label', 'skills-pick-label'), box = el('input'); box.type = 'checkbox'; box.value = s.id;
        if (s.name === selectedName) { box.checked = true; chosen.add(s.id); }
        const name = el('span', 'skills-pick-name', `${s.name} v${s.version}`), desc = el('span', 'skills-pick-desc', s.description);
        label.append(box, name, desc);
        if (team.has(s.id)) { box.checked = true; box.disabled = true; label.append(el('span', 'skills-pick-flag skills-from-team', 'from the team')); } // the team's, for every member: not this member's to change
        else if (chosen.has(s.id)) box.checked = true;
        if (s.has_scripts || s.not_reviewable) label.append(el('span', 'skills-pick-flag', s.has_scripts ? 'includes scripts' : 'includes files not shown as text'));
        li.append(label); ul.append(li);
        box.addEventListener('change', () => { if (box.checked) chosen.add(s.id); else chosen.delete(s.id); sync(); });
        return { s, li, box };
    });
    function sync() {
        const fromTeam = rows.filter(r => team.has(r.s.id)).length;
        summary.textContent = chosen.size || fromTeam ? `${chosen.size} chosen${fromTeam ? `, ${fromTeam} from the team` : ''}` : `Choose from ${list.length} skill${list.length === 1 ? '' : 's'}`;
        for (const r of rows) r.box.disabled = team.has(r.s.id) || (!r.box.checked && chosen.size >= MAX);
        note.textContent = chosen.size
            ? `${chosen.size} skill${chosen.size === 1 ? '' : 's'}: the agent is told their names and how to load them (coral-agent skills get --id <id>). A skill with scripts runs only if the agent decides to, with the agent's permissions.`
            : 'Optional. The agent is told which skills apply and how to load them. Only skills you approved are listed.';
    }
    search.addEventListener('input', () => { const q = search.value.trim().toLowerCase(); for (const r of rows) r.li.hidden = !!q && !(`${r.s.name} ${r.s.description}`.toLowerCase().includes(q)); });
    more.append(summary, search, ul, note);
    host.append(more);
    sync();
    if (chosen.size || rows.some(r => team.has(r.s.id))) more.open = true; // a member that has skills, or gets the team's, shows them (#18657)
    row.hidden = false;
}
