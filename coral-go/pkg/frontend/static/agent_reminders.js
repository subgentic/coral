// The Operator's reminders for one agent, on its page (#19350): the ones it has, each with Cancel, and an editor that adds a one-time reminder or a
// repeating one (every day, Monday to Friday, or every few minutes), built on Chief's checks screen: the same cards, schedule words, editor and buttons (#19528, the Operator). It uses the person's /api/reminders routes, which the Hub does not serve:
// then the section is not drawn. A reminder wakes the agent and stays open until it marks it done.
import { serverUrl, splitKey } from './server_base.js';
import { el } from './dom_el.js';
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
const { scheduleWords, INTERVALS } = await importOnce('./chief_checks_model.js');
await Promise.all([loadStyles('agent_reminders.css'), loadStyles('chief-checks.css')]); // not at start (page_weight)

const KINDS = [['once', 'Once'], ['every', 'Repeat'], ['daily', 'Daily'], ['weekdays', 'Weekdays']];

/** A reminder in Chief's words: "Every 15 minutes", "Daily at 09:00 · UTC", "Weekdays at 09:00 · UTC", "Once, 2026-11-18 09:00 · UTC". */
export function whenWords(r) {
    if (r.schedule_kind === 'once') return `Once, ${String(r.at || '').replace('T', ' ')}${r.timezone ? ` · ${r.timezone}` : ''}`;
    return scheduleWords(r);
}

const button = (text, fn, cls = 'btn') => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };

/** Mounts the section on host for the agent (its team key, session id and the name the board knows it by). Resolves when the first read is done. */
export async function mountAgentReminders(host, team, agent) {
    const { server, name: board } = splitKey(team);
    const list = serverUrl('/api/reminders', server);
    const read = async () => {
        const r = await fetch(list).catch(() => null);
        if (!r || !r.ok) return null;
        return ((await r.json()).reminders || []).filter(x => x.target_session === agent.session_id && x.target_board === board);
    };
    let rows = await read();
    if (!rows) return null; // not served here (the Hub), or the read failed: no section
    const who = agent.display_name || agent.name || 'This agent';
    const section = el('section', 'agent-rem');
    const title = el('h3', '', 'Reminders'); title.id = `agent-rem-title-${String(agent.session_id).replace(/[^A-Za-z0-9_-]/g, '-')}`;
    section.setAttribute('aria-labelledby', title.id);
    const say = el('p', 'chief-check-hint agent-rem-say'); say.setAttribute('role', 'status'); say.setAttribute('aria-live', 'polite');
    const tools = el('div', 'chief-check-actions');
    const cards = el('div', 'agent-rem-list');
    const add = button('New reminder', () => editor(), 'btn btn-primary agent-rem-new');
    tools.append(add);
    function draw() {
        cards.replaceChildren();
        if (!rows.length) cards.append(el('p', 'chief-check-hint', 'No reminders yet. Add one to start.'));
        for (const r of rows) {
            const card = el('section', 'chief-check-card'); card.append(el('h4', '', r.name));
            card.append(el('p', 'chief-check-hint', `${whenWords(r)}${r.paused ? ' · Off' : ''} · ${who}`));
            const acts = el('div', 'chief-check-actions');
            const remove = button('Delete', async () => {
                if (remove.dataset.confirm !== 'yes') { remove.dataset.confirm = 'yes'; remove.textContent = 'Confirm delete'; return; }
                remove.disabled = true;
                const x = await fetch(`${list}/${encodeURIComponent(r.id)}`, { method: 'DELETE' }).catch(() => null);
                if (!x || !x.ok) { remove.disabled = false; say.textContent = 'Could not delete that reminder.'; say.className = 'chief-check-error agent-rem-say'; return; }
                rows = (await read()) || rows; draw(); say.className = 'chief-check-hint agent-rem-say'; say.textContent = 'Reminder deleted.';
            });
            remove.setAttribute('aria-label', `Delete the reminder ${r.name}`);
            acts.append(remove); card.append(acts); cards.append(card);
        }
    }
    /** Chief's check editor, for a reminder: the same dialog, fields, unsaved-changes guard and buttons. */
    function editor() {
        const dialog = el('dialog', 'modal-content dlg-form chief-check-editor');
        dialog.setAttribute('aria-labelledby', 'agent-rem-editor-title');
        const heading = el('h2', '', 'New reminder'); heading.id = 'agent-rem-editor-title';
        const form = el('form', 'chief-check-form');
        let dirty = false, busy = false;
        const field = (label, input) => { const wrap = el('label', 'chief-check-field', label); wrap.append(input); form.append(wrap); return input; };
        const text = el('textarea'); text.rows = 4; text.maxLength = 1000; text.required = true; field('Instruction', text);
        const kind = el('select'); for (const [v, t] of KINDS) kind.append(Object.assign(el('option', '', t), { value: v })); field('Schedule', kind);
        const every = el('select'); for (const [v, t] of INTERVALS) every.append(Object.assign(el('option', '', t), { value: String(v) })); field('Check every', every);
        const when = el('input'); field('Time', when);
        form.append(el('p', 'chief-check-hint', `The reminder wakes ${who} and stays open until it marks it done.`));
        const error = el('p', 'chief-check-error'); error.setAttribute('role', 'alert'); error.hidden = true;
        const footer = el('div', 'chief-check-actions');
        const cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button';
        const discard = el('button', 'btn', 'Discard changes'); discard.type = 'button'; discard.hidden = true;
        const save = el('button', 'btn btn-primary', 'Save reminder'); save.type = 'submit';
        footer.append(error, cancel, discard, save); form.append(footer); dialog.append(heading, form);
        const sync = () => { const k = kind.value; every.parentElement.hidden = k !== 'every'; when.parentElement.hidden = k === 'every'; when.type = k === 'once' ? 'datetime-local' : 'time'; when.parentElement.firstChild.textContent = k === 'once' ? 'Date and time' : 'Time'; when.value = ''; };
        kind.addEventListener('change', sync); sync();
        const closing = () => {
            if (busy) return;
            if (dirty) { error.hidden = false; error.textContent = 'You have unsaved changes. Keep editing or discard them.'; discard.hidden = false; discard.focus(); }
            else dialog.close();
        };
        cancel.addEventListener('click', closing); discard.addEventListener('click', () => { if (!busy) dialog.close(); });
        dialog.addEventListener('cancel', e => { e.preventDefault(); closing(); });
        dialog.addEventListener('click', e => { if (e.target === dialog) closing(); });
        dialog.addEventListener('close', () => { dialog.remove(); add.focus(); });
        form.addEventListener('input', () => { dirty = true; }); form.addEventListener('change', () => { dirty = true; });
        form.addEventListener('submit', async ev => {
            ev.preventDefault(); if (busy || !form.reportValidity()) return;
            const body = { text: text.value.trim(), board, to: agent.subscriber_id || agent.name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
            if (!body.text) { error.hidden = false; error.textContent = 'Say what to remind it of.'; return; }
            if (kind.value === 'every') { body.kind = 'every'; body.every_minutes = Number(every.value); body.timezone = 'UTC'; }
            else { if (!when.value) { error.hidden = false; error.textContent = 'Choose when.'; return; } body.kind = kind.value; body.at = when.value.slice(0, 16); }
            busy = true; save.disabled = cancel.disabled = discard.disabled = true; error.hidden = true; form.setAttribute('aria-busy', 'true');
            try {
                const r = await fetch(list, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
                if (!r || !r.ok) {
                    const why = r ? (await r.json().catch(() => ({}))).error : '';
                    error.hidden = false; error.textContent = why ? `Could not add it: ${why}` : 'Could not add the reminder. Try again.';
                    return;
                }
                rows = (await read()) || rows; draw(); say.className = 'chief-check-hint agent-rem-say'; say.textContent = 'Reminder added.'; dirty = false; dialog.close();
            } finally { busy = false; save.disabled = cancel.disabled = discard.disabled = false; form.removeAttribute('aria-busy'); }
        });
        document.body.append(dialog); dialog.showModal(); text.focus();
        return dialog;
    }
    draw();
    section.append(title, el('p', 'chief-check-hint', `What ${who} is reminded of, and when.`), tools, say, cards);
    host.append(section);
    return section;
}
