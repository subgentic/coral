/* Skills in New agent and New team (#12104, goal #191): an optional list of the skills the Operator approved, ticked one or more; the launch then carries their ids and the server tells the agent which skills apply
 * and how to load them (the launch note). Only this computer's approved skills are offered, so the row is hidden for another computer and when there are none. Everything a skill says is drawn with textContent. */
import { loadStyles } from './lazy_styles.js';
import { requestJson } from './api.js';
await loadStyles('skills.css');

const MAX = 10; // the server's limit for one launch
const picked = new Map(); // row id -> Set of skill ids
const generation = new Map(); // row id -> the latest mount: an answer that arrives after a newer mount began is dropped

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The ids ticked in the row ('launch-skills' or 'team-skills'), none when the row is hidden. */
export function launchSkillIds(rowId) {
    const row = document.getElementById(`${rowId}-row`);
    return row && !row.hidden && !(rowId === 'launch-skills' && document.getElementById('launch-modal')?.hasAttribute('data-member')) ? [...(picked.get(rowId) || [])] : [];
}

/** Draw the row: the approved skills with a tick each. local is false for another computer's launch (its skills are its own: not offered here). */
export async function mountLaunchSkills(rowId, local) {
    const row = document.getElementById(`${rowId}-row`), host = document.getElementById(`${rowId}-host`);
    if (!row || !host) return;
    const mine = (generation.get(rowId) || 0) + 1; generation.set(rowId, mine);
    picked.set(rowId, new Set());
    row.hidden = true; host.replaceChildren();
    if (!local) return;
    let list = [];
    try { list = (await requestJson('GET', '/api/skills?status=approved')).skills || []; } catch { return; }
    if (!list.length || generation.get(rowId) !== mine) return;
    const chosen = picked.get(rowId);
    const search = el('input', 'skills-pick-search'); search.type = 'search'; search.placeholder = 'Search skills'; search.setAttribute('aria-label', 'Search skills');
    const note = el('p', 'skills-note');
    const more = el('details', 'skills-pick-more'), summary = el('summary', 'skills-pick-summary'); // closed: an optional list does not push the dialog's buttons off a short window (#12495)
    const ul = el('ul', 'skills-pick-list');
    const rows = list.map(s => {
        const li = el('li', 'skills-pick'), label = el('label', 'skills-pick-label'), box = el('input'); box.type = 'checkbox'; box.value = s.id;
        const name = el('span', 'skills-pick-name', `${s.name} v${s.version}`), desc = el('span', 'skills-pick-desc', s.description);
        label.append(box, name, desc);
        if (s.has_scripts || s.not_reviewable) label.append(el('span', 'skills-pick-flag', s.has_scripts ? 'includes scripts' : 'includes files not shown as text'));
        li.append(label); ul.append(li);
        box.addEventListener('change', () => { if (box.checked) chosen.add(s.id); else chosen.delete(s.id); sync(); });
        return { s, li, box };
    });
    function sync() {
        summary.textContent = chosen.size ? `${chosen.size} chosen` : `Choose from ${list.length} skill${list.length === 1 ? '' : 's'}`;
        for (const r of rows) r.box.disabled = !r.box.checked && chosen.size >= MAX;
        note.textContent = chosen.size
            ? `${chosen.size} skill${chosen.size === 1 ? '' : 's'}: the agent is told their names and how to load them (coral-agent skills get --id <id>). A skill with scripts runs only if the agent decides to, with the agent's permissions.`
            : 'Optional. The agent is told which skills apply and how to load them. Only skills you approved are listed.';
    }
    search.addEventListener('input', () => { const q = search.value.trim().toLowerCase(); for (const r of rows) r.li.hidden = !!q && !(`${r.s.name} ${r.s.description}`.toLowerCase().includes(q)); });
    more.append(summary, search, ul, note);
    host.append(more);
    sync();
    row.hidden = false;
}
