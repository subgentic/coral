/* Attach an approved store skill to existing local team members and tell them
 * now. Uses the same pinned attachment and send routes as the $skill composer. */
import { state } from './state.js';
import { requestJson } from './api.js';
import { sessionServer } from './server_base.js';
const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
export function showSkillUse(host, skill, onAttached = () => {}) {
    host.replaceChildren();
    const members = (state.liveSessions || []).filter(row => row.session_id && !row.archived && sessionServer(row) === 'local');
    host.append(el('h3', 'Use in a team'), el('p', 'Attach this skill to current members and send them its reading instruction. No restart is needed. Future members are not changed.'));
    if (!members.length) { host.append(el('p', 'No local agents are available. Start a team or agent first.')); return; }
    const targets = new Map(), teams = new Map();
    for (const row of members) {
        if (row.board_project) { if (!teams.has(row.board_project)) teams.set(row.board_project, []); teams.get(row.board_project).push(row); }
    }
    const label = el('label', 'Team or member'); label.htmlFor = 'skill-use-target';
    const select = el('select'); select.id = 'skill-use-target';
    const option = (key, text, rows) => { const node = el('option', text); node.value = key; select.append(node); targets.set(key, rows); };
    for (const [team, rows] of teams) option(`team:${team}`, `${team} · all ${rows.length} current members`, rows);
    for (const row of members) option(`member:${row.session_id}`, `${row.board_project ? row.board_project + ' · ' : ''}${row.display_name || row.name}`, [row]);
    const submit = el('button', 'Attach and tell agents'); submit.type = 'button'; submit.className = 'btn btn-primary'; submit.id = 'skill-use-submit';
    const results = el('div'); results.id = 'skill-use-results'; results.setAttribute('role', 'status'); results.setAttribute('aria-live', 'polite');
    const controls = el('p'); controls.append(submit); host.append(label, select, controls, results);
    let busy = false;
    select.addEventListener('change', () => { if (!busy) { submit.disabled = false; results.replaceChildren(); } });
    submit.addEventListener('click', async () => {
        if (busy) return;
        const selected = targets.get(select.value) || []; if (!selected.length) return;
        busy = true; submit.disabled = true; select.disabled = true; results.textContent = 'Attaching and telling agents…';
        const list = el('ul'), attachedTeams = new Set(); let told = 0;
        for (const row of selected) {
            const name = row.display_name || row.name || row.session_id;
            let attached = false;
            try {
                const path = `/api/sessions/live/${encodeURIComponent(`${row.agent_type}-${row.session_id}`)}`;
                const answer = await requestJson('POST', `${path}/skills?session_id=${encodeURIComponent(row.session_id)}`, { skill_id: skill.id });
                if (!answer.attached || typeof answer.line !== 'string' || !answer.line.trim()) throw new Error('Attachment was not confirmed.');
                attached = true; if (row.board_project) attachedTeams.add(row.board_project);
                const sent = await requestJson('POST', `${path}/send`, { command: answer.line, agent_type: row.agent_type, session_id: row.session_id });
                if (sent.error) throw new Error(sent.error);
                if (sent.held) list.append(el('li', `${name}: attached; message held until the current question is answered.`));
                else { told++; list.append(el('li', `${name}: attached and told.`)); }
            } catch (error) {
                list.append(el('li', `${name}: ${attached ? 'attached, but the message was not confirmed' : 'not attached'} (${error.message || 'check the connection'}).`));
            }
        }
        onAttached([...attachedTeams]);
        results.replaceChildren(el('p', `Attached and told ${told} agent${told === 1 ? '' : 's'}.`), list);
        // A repeated click could duplicate a message whose receipt was lost. A
        // new selection is a separate explicit action; no automatic resend.
        select.disabled = false; busy = false;
    });
}
