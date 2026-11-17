// The Operator's reminders for one agent, on its page (#19350): the ones it has, each with Cancel, and a form that adds a one-time reminder or a
// repeating one (every day, Monday to Friday, or every few minutes). It uses the person's /api/reminders routes, which the Hub does not serve:
// then the section is not drawn. A reminder wakes the agent and stays open until it marks it done.
import { serverUrl, splitKey } from './server_base.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('agent_reminders.css'); // not at start (page_weight)

const EVERY = [5, 15, 30, 60];
const KINDS = [['once', 'Once'], ['daily', 'Every day'], ['weekdays', 'Monday to Friday'], ['every', 'Every few minutes']];

/** A reminder in words: "once 2026-11-18 09:00", "every day at 09:00", "every 15 min". */
export function whenWords(r) {
    switch (r.schedule_kind) {
    case 'once': return `once, ${String(r.at || '').replace('T', ' ')} ${r.timezone || ''}`.trim();
    case 'interval': return `every ${r.every_minutes} min`;
    case 'daily': return `every day at ${r.at} ${r.timezone || ''}`.trim();
    case 'weekdays': return `Monday to Friday at ${r.at} ${r.timezone || ''}`.trim();
    default: return String(r.schedule_kind || '');
    }
}

const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

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
    const section = mk('section');
    const title = mk('h3', null, 'Reminders'); title.id = `agent-rem-title-${String(agent.session_id).replace(/[^A-Za-z0-9_-]/g, '-')}`;
    section.setAttribute('aria-labelledby', title.id);
    const ul = mk('ul', 'agent-rem-list');
    const say = mk('p', 'sv-help agent-rem-say'); say.setAttribute('role', 'status');
    const form = mk('form', 'agent-rem-form');
    const field = (label, input) => { const l = mk('label', 'agent-rem-field'); l.append(mk('span', 'sv-help', label), input); return l; };
    const text = mk('input'); text.type = 'text'; text.maxLength = 1000; text.required = true;
    const kind = mk('select'); for (const [v, t] of KINDS) kind.append(Object.assign(mk('option', null, t), { value: v }));
    const when = mk('input'); when.type = 'datetime-local';
    const every = mk('select'); for (const m of EVERY) every.append(Object.assign(mk('option', null, `${m} minutes`), { value: String(m) }));
    const add = mk('button', 'btn', 'Add reminder'); add.type = 'submit';
    const sync = () => { const k = kind.value; whenField.hidden = k === 'every'; everyField.hidden = k !== 'every'; when.type = k === 'once' ? 'datetime-local' : 'time'; when.value = ''; };
    const whenField = field('When', when), everyField = field('How often', every);
    form.append(field('Remind with', text), field('Repeat', kind), whenField, everyField, add);
    kind.addEventListener('change', sync);
    const draw = () => {
        ul.replaceChildren();
        if (!rows.length) ul.append(mk('li', 'sv-help', 'No reminders.'));
        for (const r of rows) {
            const li = mk('li');
            const words = mk('span', 'agent-rem-text', `${r.name} (${whenWords(r)}${r.paused ? ', off' : ''})`);
            const b = mk('button', 'btn', 'Cancel'); b.type = 'button'; b.setAttribute('aria-label', `Cancel the reminder ${r.name}`);
            b.addEventListener('click', async () => {
                b.disabled = true;
                const x = await fetch(`${list}/${encodeURIComponent(r.id)}`, { method: 'DELETE' }).catch(() => null);
                if (!x || !x.ok) { b.disabled = false; say.textContent = 'Could not cancel that reminder.'; return; }
                rows = (await read()) || rows; draw(); say.textContent = 'Reminder cancelled.';
            });
            li.append(words, b); ul.append(li);
        }
    };
    form.addEventListener('submit', async ev => {
        ev.preventDefault();
        const body = { text: text.value.trim(), board, to: agent.subscriber_id || agent.name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
        if (!body.text) { say.textContent = 'Say what to remind it of.'; return; }
        if (kind.value === 'every') { body.kind = 'every'; body.every_minutes = Number(every.value); body.timezone = 'UTC'; }
        else { if (!when.value) { say.textContent = 'Choose when.'; return; } body.kind = kind.value; body.at = when.value.slice(0, 16); }
        add.disabled = true;
        const r = await fetch(list, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
        add.disabled = false;
        if (!r || !r.ok) {
            const why = r ? (await r.json().catch(() => ({}))).error : '';
            say.textContent = why ? `Could not add it: ${why}` : 'Could not add the reminder. Try again.';
            return;
        }
        text.value = ''; sync();
        rows = (await read()) || rows; draw(); say.textContent = 'Reminder added.';
    });
    sync(); draw();
    section.append(title, ul, form, say);
    host.append(section);
    return section;
}
