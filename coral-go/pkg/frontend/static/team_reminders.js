// A team's agent reminders in Settings (#19288): each member's count of reminders still to come (the next time on hover) and a switch that turns that agent's
// reminders off and back on without deleting them. The server's GET /api/reminders/agents?board= and POST /api/reminders/agents/<session>/switch are the person's
// only and not served through Coral Hub (then there is no group). Each switch saves on its own, not with the page's Save bar.
import { serverUrl, splitKey } from './server_base.js';

const countWords = n => (n === 1 ? '1 reminder' : `${n} reminders`);

/** When the next one fires, for the hover. */
export function nextWords(nextAt, locale) {
    const t = Date.parse(nextAt || '');
    return Number.isFinite(t) ? `Next: ${new Date(t).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Nothing is due';
}

/** The row's words: "3 reminders", "2 of 3 on" when some are off, "3 reminders, off" when all are. */
export function rowWords(a) {
    if (!a.count) return 'No reminders';
    if (a.active === a.count) return countWords(a.count);
    return a.active ? `${a.active} of ${a.count} on` : `${countWords(a.count)}, off`;
}

export function createTeamReminders(team) {
    const { server, name } = splitKey(team);
    const listUrl = serverUrl(`/api/reminders/agents?board=${encodeURIComponent(name)}`, server);
    let slot = null, rows = [], viewOff = false;
    // The settings view enables or disables every control of a custom field together; an agent with no reminders keeps its switch disabled after it.
    const reapply = () => { if (slot) for (const box of slot.querySelectorAll('input[data-session]')) box.disabled = viewOff || !rows.find(a => a.session_id === box.dataset.session)?.count; };
    const say = (text) => { const p = slot.querySelector('.rem-say'); if (p) p.textContent = text || ''; };
    const draw = () => {
        if (!slot) return;
        slot.replaceChildren();
        const ul = document.createElement('ul');
        ul.className = 'rem-agents';
        ul.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px';
        if (!rows.length) { const p = document.createElement('p'); p.className = 'sv-help'; p.textContent = 'No agents on this team yet.'; slot.append(p); return; }
        for (const a of rows) {
            const li = document.createElement('li');
            li.style.cssText = 'display:flex;align-items:center;gap:10px';
            const box = document.createElement('input');
            box.type = 'checkbox'; box.setAttribute('role', 'switch');
            box.id = `rem-sw-${a.session_id}`;
            box.checked = a.active > 0;
            box.disabled = !a.count;
            box.dataset.session = a.session_id;
            const label = document.createElement('label');
            label.htmlFor = box.id; label.textContent = a.name;
            const words = document.createElement('span');
            words.className = 'sv-help rem-count';
            words.textContent = rowWords(a);
            words.title = nextWords(a.next_at);
            box.setAttribute('aria-label', `${a.name}'s reminders`);
            box.addEventListener('change', () => toggle(a, box));
            li.append(box, label, words);
            ul.append(li);
        }
        const note = document.createElement('p'); note.className = 'sv-help rem-say'; note.setAttribute('role', 'status');
        slot.append(ul, note);
    };
    const read = async () => {
        const r = await fetch(listUrl).catch(() => null);
        if (!r || !r.ok) return null;
        return (await r.json()).agents || [];
    };
    async function toggle(a, box) {
        const on = box.checked;
        box.disabled = true;
        const r = await fetch(serverUrl(`/api/reminders/agents/${encodeURIComponent(a.session_id)}/switch`, server), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board: name, on }) }).catch(() => null);
        if (!r || !r.ok) {
            box.checked = !on; box.disabled = false;
            say(`Could not turn ${a.name}'s reminders ${on ? 'on' : 'off'}.`);
            return;
        }
        rows = (await read()) || rows;
        draw();
        say(`${a.name}'s reminders are ${on ? 'on' : 'off'}.`);
    }
    return {
        fields: () => [{ key: 'agent_reminders', type: 'custom', label: 'Reminders for each agent', wide: true, help: 'A reminder wakes the agent it is for. Off keeps them, says nothing, and brings back a one-time reminder that came due while it was off.', render: s => { slot = s; draw(); return { get: () => undefined, set: () => {}, disable: on => { viewOff = !!on; queueMicrotask(reapply); } }; } }],
        /** Reads the counts. Resolves to false when the server does not give them to this page (the group is then removed). */
        async load() {
            const got = await read();
            if (!got) return false;
            rows = got;
            draw();
            return true;
        },
    };
}
