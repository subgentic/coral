// The Operator's two changes to a goal (#12693): who drives it, and which team it belongs to. Both are the Operator's alone; through a Hub (coral-hub's or our own) they are made on the goal's own computer, and with the Hub's goal_preview they are previewed first (#13517).
import { boardFetch, serverFetch, splitKey, identityKey } from './server_base.js';
import { importOnce } from './import_once.js';
const { goalWrite } = await importOnce('./goal_write.js');
import { toDrivers, errorOf } from './goals_adapter.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

async function say(r) {
    let e = { code: '', message: '' };
    try { e = errorOf(await r.json()); } catch { /* the status stays */ }
    return e.message || `HTTP ${r.status}`;
}

async function membersOf(project) {
    const r = await boardFetch(project, '/subscribers');
    if (!r.ok) throw new Error(String(r.status));
    return toDrivers(await r.json());
}

function dialog(titleText, id) {
    const dlg = document.createElement('dialog'); dlg.className = 'dlg-confirm goals-dialog goals-operator-dialog'; dlg.setAttribute('aria-labelledby', id);
    const form = el('form', 'goals-form'); form.noValidate = true;
    const title = el('h3', null, titleText); title.id = id;
    const head = el('div', 'goals-form-head'), body = el('div', 'goals-form-body');
    const back = btn('goals-form-back', null, () => dlg.close()); back.setAttribute('aria-label', 'Back'); back.title = 'Back';
    const arrow = el('span', 'material-icons', 'arrow_back'); arrow.setAttribute('aria-hidden', 'true'); back.append(arrow);
    head.append(back, title); form.append(head, body);
    return { dlg, form, body };
}

const field = (label, control, id) => { const l = el('label', 'goals-field'); control.id = id; l.append(el('span', null, label), control); return l; };

/** The Change driver dialog: a select of the team's members (and "No driver"); Save sends the one route. */
export function openChangeDriver({ project, goal, onDone, onClose }) {
    const { dlg, form, body } = dialog('Change who drives this goal', 'goal-driver-title');
    const sel = el('select'); sel.disabled = true; sel.append(new Option('Loading…', ''));
    const err = el('p', 'goals-field-error'); err.setAttribute('role', 'alert');
    const go = btn('btn btn-primary', 'Save'); go.type = 'submit'; go.disabled = true;
    const actions = el('div', 'goals-actions'); actions.append(btn('btn', 'Cancel', () => dlg.close()), go);
    body.append(el('p', 'goals-close-goal', goal.title), field('Driver', sel, 'goal-driver-select'), el('p', 'goals-note', 'The driver is told on the board, as when a goal is given to them.'), err);
    form.append(actions);
    dlg.append(form); document.body.append(dlg);
    membersOf(project).then(people => {
        sel.replaceChildren(...people.map(p => new Option(p.label, p.id)), new Option('No driver', ''));
        sel.value = people.some(p => p.id === goal.driver) ? goal.driver : '';
        sel.disabled = false; go.disabled = false;
    }).catch(() => { sel.replaceChildren(new Option('The team\'s agents could not be read', '')); err.textContent = 'The team\'s agents could not be read. Close this and try again.'; });
    form.addEventListener('submit', async e => {
        e.preventDefault(); err.textContent = ''; go.disabled = true;
        try {
            const r = await goalWrite(project, 'goal_driver', goal.id, `/goals/${goal.id}/driver`, 'POST', { driver: sel.value });
            if (!r.ok) throw new Error(await say(r));
            dlg.close(); await onDone(sel.value);
        } catch (ex) { err.textContent = `Not changed: ${ex.message}`; go.disabled = false; }
    });
    dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
    dlg.showModal(); sel.focus();
}

/** The Move dialog: the other team, and (optionally) a driver from that team. It says what moves and what stays before anything is sent. */
export function openMoveGoal({ project, goal, openTasks, onMoved, onClose }) {
    const { dlg, form, body } = dialog('Give this goal to another team', 'goal-move-title');
    const teamSel = el('select'); teamSel.append(new Option('Loading…', '')); teamSel.disabled = true;
    const driverSel = el('select'); driverSel.append(new Option('No driver yet: that team\'s Orchestrator is told', '')); driverSel.disabled = true;
    const err = el('p', 'goals-field-error'); err.setAttribute('role', 'alert');
    const stays = openTasks > 0 ? `Its ${openTasks} open task${openTasks === 1 ? '' : 's'} stay${openTasks === 1 ? 's' : ''} on this team, unchanged.` : 'It has no open task to leave behind.';
    const what = el('p', 'goals-note'); what.id = 'goal-move-what';
    what.textContent = `The goal is copied to the other team with its title, description, done-when and pictures, and this one is closed as dropped with "moved to that team". ${stays} Comments stay here. Each team's board gets a line.`;
    dlg.setAttribute('aria-describedby', what.id);
    const go = btn('btn btn-primary', 'Give goal'); go.type = 'submit'; go.disabled = true;
    const actions = el('div', 'goals-actions'); actions.append(btn('btn', 'Cancel', () => dlg.close()), go);
    body.append(el('p', 'goals-close-goal', goal.title), what, field('Team', teamSel, 'goal-move-team'), field('Driver there (optional)', driverSel, 'goal-move-driver'), err);
    form.append(actions);
    dlg.append(form); document.body.append(dlg);
    const { server, name: here } = splitKey(project); // the other teams are the goal's own computer's: the move is made there (#13517)
    serverFetch(server, '/api/board/projects').then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(rows => {
        const others = (Array.isArray(rows) ? rows : []).filter(t => t && t.board_id && t.board_id !== here);
        teamSel.replaceChildren(new Option(others.length ? 'Choose a team' : 'There is no other team', ''), ...others.map(t => new Option(t.board_label || t.board_id, t.board_id)));
        teamSel.disabled = !others.length;
    }).catch(() => { teamSel.replaceChildren(new Option('The teams could not be read', '')); });
    teamSel.addEventListener('change', async () => {
        go.disabled = !teamSel.value; driverSel.disabled = true;
        driverSel.replaceChildren(new Option('No driver yet: that team\'s Orchestrator is told', ''));
        if (!teamSel.value) return;
        const asked = teamSel.value;
        try {
            const people = await membersOf(identityKey(server, asked));
            if (teamSel.value !== asked) return; // another team was chosen meanwhile: a slower answer must not fill this list
            driverSel.replaceChildren(new Option('No driver yet: that team\'s Orchestrator is told', ''), ...people.map(p => new Option(p.label, p.id)));
        } catch { /* the driver stays optional */ }
        driverSel.disabled = false;
    });
    form.addEventListener('submit', async e => {
        e.preventDefault(); err.textContent = ''; if (!teamSel.value) return; go.disabled = true;
        try {
            const r = await goalWrite(project, 'goal_move', goal.id, `/goals/${goal.id}/move`, 'POST', { to_project: teamSel.value, driver: driverSel.value });
            if (!r.ok) throw new Error(await say(r));
            const out = await r.json();
            dlg.close(); await onMoved(out, teamSel.selectedOptions[0]?.textContent || teamSel.value);
        } catch (ex) { err.textContent = `Not moved: ${ex.message}`; go.disabled = false; }
    });
    dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
    dlg.showModal(); teamSel.focus();
}
