/* How far an agent's chat search reaches (#11048, #11053): the level is on the agent's team member row (GET /api/teams/detail/{team} members[].search_reach; every member starts at "own") and only the Operator raises it
 * (PUT /api/team-members/{id}/search-access, never through the Hub: there the dialog shows the level and says where to change it). "own" shows nothing, so a chip means the agent reads beyond its own board. The top level
 * asks again in the same dialog (focus on Back) before it is saved. The dialog is a native <dialog> like the Remind dialog: Escape closes it, the focus goes back to the button that opened it. */
import { teamFetch, isCloud } from './server_base.js';
import { importOnce } from './import_once.js';
const { stateChip } = await importOnce('./team_table.js');

export const LEVELS = [
    ['own', 'Own board only', "its own board's messages (the default)"],
    ['team', 'Its team', "every board of its team"],
    ['all', 'All teams', "every team's boards on this Coral"],
    ['operator', 'All + operator history', 'also your own boards and your own Claude/Codex conversations on this computer'],
];
const WORD = { team: 'team', all: 'all teams', operator: 'all + operator history' };
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The chip of a level above "own" (null at "own": no chip); the top level is drawn as a warning. */
export function searchChip(level) {
    return WORD[level] ? stateChip(`Search: ${WORD[level]}`, level === 'operator' ? 'goal-state-blocked' : '') : null;
}

/** The team's members' levels, by agent name: { id, level }; an empty map when the read fails (the control is then not offered). */
export async function readSearchLevels(team) {
    const out = new Map();
    try {
        const r = await teamFetch(team, n => `/api/teams/detail/${encodeURIComponent(n)}`);
        const d = r.ok ? await r.json() : null;
        for (const m of (d && d.members) || []) if (m && m.agent_name && Number.isFinite(m.id)) out.set(m.agent_name, { id: m.id, level: m.search_reach || 'own' });
    } catch { /* no levels: no chip and no control */ }
    return out;
}

let dialog = null;
const close = () => { if (dialog && dialog.open) dialog.close(); };

/** Open the dialog for one member: { name, id, level }; opts.opener takes the focus back, opts.readOnly forces the Hub's read-only dialog (isCloud() by default), opts.onChanged(level) runs after a save. */
export function openSearchAccess(member, opts = {}) {
    if (!dialog) {
        dialog = mk('dialog', 'modal-content dlg-confirm reminder-dialog search-access-dialog');
        dialog.id = 'search-access-dialog';
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'search-access-title');
        dialog.addEventListener('cancel', e => { if (dialog.dataset.busy) e.preventDefault(); });
        document.body.appendChild(dialog);
    }
    close();
    const readOnly = opts.readOnly ?? isCloud(); // the raise route is the Operator's on this computer alone
    let level = member.level;
    const title = mk('h3', null, `Search access: ${member.name}`); title.id = 'search-access-title';
    const err = mk('div', 'field-error'); err.setAttribute('role', 'alert'); err.hidden = true;
    const acts = mk('div', 'modal-actions modal-footer');
    const cancel = mk('button', 'btn', readOnly ? 'Close' : 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', close);
    const go = mk('button', 'btn btn-primary', 'Save'); go.type = 'button';

    const save = async confirm => {
        err.hidden = true; go.disabled = cancel.disabled = true; dialog.dataset.busy = '1';
        let res = null, msg = '';
        try {
            const r = await fetch(`/api/team-members/${encodeURIComponent(member.id)}/search-access`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(confirm ? { level, confirm: 'operator' } : { level }) });
            res = r.ok ? await r.json().catch(() => ({ ok: true })) : null;
            if (!r.ok) msg = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`;
        } catch (e) { msg = (e && e.message) || 'Could not save.'; }
        delete dialog.dataset.busy; go.disabled = cancel.disabled = false;
        if (res) { member.level = level; close(); opts.onChanged?.(level); return; }
        err.textContent = msg; err.hidden = false; go.focus();
    };

    const first = () => {
        const body = mk('div', 'modal-body search-access-body');
        if (readOnly) body.append(mk('p', 'search-access-note', `Search reaches: ${(LEVELS.find(l => l[0] === level) || LEVELS[0])[1].toLowerCase()}. Change this on the machine's own dashboard.`));
        else {
            const list = mk('div', 'search-access-levels'); list.setAttribute('role', 'radiogroup'); list.setAttribute('aria-labelledby', 'search-access-title');
            for (const [key, word, reads] of LEVELS) {
                const row = mk('label', 'search-access-level'); const radio = mk('input'); radio.type = 'radio'; radio.name = 'search-level'; radio.value = key; radio.checked = key === level;
                radio.addEventListener('change', () => { level = key; go.textContent = key === 'operator' ? 'Continue' : 'Save'; });
                const text = mk('span', 'search-access-text'); text.append(mk('span', 'search-access-word', word), mk('span', 'search-access-reads', reads));
                row.append(radio, text); list.append(row);
            }
            body.append(list, mk('p', 'search-access-note', 'Changes are logged (who, when, level; never the text). A cloned or imported member starts at "own".'));
        }
        body.append(err);
        acts.replaceChildren(cancel);
        if (!readOnly) acts.append(go);
        go.textContent = level === 'operator' ? 'Continue' : 'Save';
        dialog.replaceChildren(mk('div', 'modal-header', null), body, acts);
        dialog.firstChild.append(title);
    };
    const confirmStep = () => { // the top level asks again, in this dialog
        const h = mk('h3', null, `Let ${member.name} search your chat history?`); h.id = 'search-access-title';
        const body = mk('div', 'modal-body search-access-body'); body.append(mk('p', null, 'It will be able to read your own boards and your own Claude/Codex conversations on this computer, not only its team’s. You can lower this any time.'), err);
        const back = mk('button', 'btn', 'Back'); back.type = 'button'; back.addEventListener('click', () => { first(); });
        const allow = mk('button', 'btn btn-danger', 'Allow all history'); allow.type = 'button'; allow.addEventListener('click', () => save(true));
        const bar = mk('div', 'modal-actions modal-footer'); bar.append(back, allow);
        const head = mk('div', 'modal-header'); head.append(h);
        dialog.setAttribute('aria-labelledby', 'search-access-title');
        dialog.replaceChildren(head, body, bar);
        back.focus();
    };
    go.addEventListener('click', () => { if (level === member.level) { close(); return; } if (level === 'operator') confirmStep(); else save(false); });
    first();
    dialog.addEventListener('close', () => { if (opts.opener && opts.opener.isConnected) opts.opener.focus({ preventScroll: true }); }, { once: true });
    dialog.showModal();
}
