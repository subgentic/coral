// A folder card is formed from recorded session folders, never terminal text.
import { state } from './state.js';
import { isCloud, sessionServer, serverFetch } from './server_base.js';
import { blockedReason } from './hub_access.js';
import { importOnce } from './import_once.js';
const { readTrustAsk } = await importOnce('./inbox_answer.js');
import { resolveSessionIdentity } from './session_state.js';
import { showToast } from './utils.js';
const reads = new Map(), values = new Map();
const flight = new Map(); // a group's answer in flight or done, by its members: the list is drawn again while the answers are checked, and the card made anew must show the same (#20865)
const key = s => JSON.stringify([sessionServer(s), s.session_id, s.waiting_since, s.waiting_summary, s.working_directory]);
const recorded = s => typeof s.working_directory === 'string' ? s.working_directory : '';
const eligible = s => !isCloud() && sessionServer(s) === 'local' && s.agent_type === 'claude' && s.session_id && recorded(s) && !blockedReason('local', 'interact') && !s.review && !s.operatorAsk;
export function prepareTrustRows(rows, redraw) {
    for (const s of rows) if (eligible(s) && !reads.has(key(s))) {
        const k = key(s);
        reads.set(k, readTrustAsk(s).catch(() => null).then(r => { values.set(k, r); redraw(); }));
    }
 }
export const folderPermission = s => !!values.get(key(s));
export function trustRows(rows, redraw) {
    prepareTrustRows(rows, redraw);
    const out = [], groups = new Map();
    for (const s of rows) {
        const r = eligible(s) && values.get(key(s));
        if (!r?.trust || r.trust.folder !== recorded(s)) { out.push(s); continue; }
        const folder = recorded(s);
        let group = groups.get(folder);
        if (!group) { group = { ...s, trustGroup: { folder, members: [] }, waiting_kind: 'permission' }; groups.set(folder, group); out.push(group); }
        group.trustGroup.members.push({ session: { ...s }, ask: r.ask, yes: { ...r.trust.yes } });
        group.display_name = `Trust folder · ${group.trustGroup.members.length} agent${group.trustGroup.members.length === 1 ? '' : 's'}`;
        group.waiting_summary = folder;
    }
    return out;
}
const el = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls; if (text) e.textContent = text; return e; };
export function trustGroupCell(row) {
    const { folder, members } = row.trustGroup;
    const cell = el('div', 'inbox-answers inbox-trust-group');
    const note = el('span', 'inbox-trust-note');
    note.append(`${members.length} agent${members.length === 1 ? '' : 's'} asks to trust `, el('code', 'inbox-trust-path', folder), '. This is a lasting answer: Claude remembers this folder for future agents.');
    const go = el('button', 'btn btn-primary inbox-answer inbox-trust-go', 'Yes, I trust this folder'); go.type = 'button';
    const names = el('span', 'inbox-trust-note inbox-trust-members', members.map(m => resolveSessionIdentity(m.session)).join(', '));
    cell.append(note, names, go);
    const gk = JSON.stringify([folder, members.map(m => key(m.session))]);
    cell.dataset.group = gk;
    const before = flight.get(gk);
    if (before?.said) cell.replaceChildren(el('span', 'inbox-trust-note inbox-trust-results', before.said));
    else if (before) go.disabled = true;
    go.addEventListener('click', async event => {
        event.stopPropagation(); go.disabled = true;
        if (flight.has(gk)) return;
        flight.set(gk, {});
        if (flight.size > 50) flight.delete(flight.keys().next().value);
        const skipped = [], sent = [], pending = [];
        for (const m of members) {
            const s = m.session, who = resolveSessionIdentity(s);
            try {
                const live = (state.liveSessions || []).find(x => x.session_id === s.session_id && sessionServer(x) === 'local');
                if (!live || !eligible(live) || recorded(live) !== folder) { skipped.push(who); continue; }
                const now = await readTrustAsk(live);
                if (!now || now.ask !== m.ask || now.trust.folder !== folder || now.trust.yes.label !== m.yes.label || Number(now.trust.yes.n) !== Number(m.yes.n)) { skipped.push(who); continue; }
                const response = await serverFetch('local', `/api/sessions/live/${encodeURIComponent(live.name)}/answer-prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: live.session_id, agent_type: live.agent_type, ask_id: now.ask, n: Number(now.trust.yes.n), label: now.trust.yes.label, text: '', trust_folder: folder }) });
                if (response.ok) sent.push(who);
                else { const answer = await response.json().catch(() => ({})); (answer.code === 'answer_sent_prompt_open' ? pending : skipped).push(who); }
            } catch { skipped.push(who); }
        }
        const said = [`Answered ${sent.length} of ${members.length} agents.`, skipped.length ? `Not answered: ${skipped.join(', ')}. Open these agents to review their current question.` : '', pending.length ? `Sent, still waiting: ${pending.join(', ')}.` : ''].filter(Boolean).join(' ');
        flight.set(gk, { said });
        for (const c of document.querySelectorAll('.inbox-trust-group')) if (c.dataset.group === gk) c.replaceChildren(el('span', 'inbox-trust-note inbox-trust-results', said)); // this card, or the one a redraw made in its place
        cell.replaceChildren(el('span', 'inbox-trust-note inbox-trust-results', said));
        showToast(said, !!skipped.length || !!pending.length, 12000);
    });
    go.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); });
    return cell;
}
