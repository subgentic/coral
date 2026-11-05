/* An agent's permission card, in a dialog over the Inbox (#11837, moment 3): a Needs you row for an agent that waits on a permission (the folder-trust card every new agent opens with) used to send the person to the Agents tab,
 * out of the Inbox on the very first step. Open now shows what the agent asks, the lines it wants to run, and the card's own choices as buttons, answered through the same route as the chat card (POST .../answer-prompt: the
 * server re-reads the terminal and sends the choice only if it is still on screen under that label, and for the ask the dialog was drawn for: ask_id). This is the full card, so the choices that last ("trust this folder",
 * "don't ask again") are here, unlike on a row (inbox_answer.js leaves those to Open, which is this). A request that can only be rejected (only_reject) offers the No form alone. A card with no one choice to take (a
 * multi-select, a review step, a text answer) says so and has Open agent. Everything the agent or the CLI wrote is set as text. */
import { serverFetch, sessionServer } from './server_base.js';
import { importOnce } from './import_once.js';
import { showToast } from './utils.js';
import { blockedReason } from './hub_access.js';
import { resolveSessionIdentity } from './session_state.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('permission_card_dialog.css'); // the card's own layout (#13169): not the Operator question dialog's grid

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const REJECT_FORM = /^(?:no|deny|reject|cancel)\b/i;

/** Whether the row can open its card here: a permission this computer's person may answer (not a login, not a viewer through the Hub). */
export const canOpenCard = s => s.waiting_kind === 'permission' && !!s.agent_type && !!s.session_id && !blockedReason(sessionServer(s), 'interact');

async function readCard(s) {
    const params = new URLSearchParams({ after: '0', limit: '1', session_id: s.session_id, agent_type: s.agent_type || '' });
    const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/chat?${params}`);
    if (!resp.ok) return null;
    const reply = await resp.json().catch(() => null) || {};
    const po = reply.prompt_options;
    if (!po) return null;
    const onlyReject = !!po.only_reject || !!(reply.pending && reply.pending.input && reply.pending.input.only_reject === true);
    const options = (po.options || []).filter(o => (o.action || 'select') === 'select' && o.label && Number.isInteger(Number(o.n)) && (!onlyReject || REJECT_FORM.test(String(o.label).trim())));
    return { title: String(po.title || ''), question: String(po.question || ''), target: String(po.target || ''), ask: String(po.ask_id || ''), options, single: !po.multi && !(po.review || []).length, onlyReject, note: String(po.note || '') };
}

const openAgent = s => { window.switchNavTab?.('agents'); Promise.resolve(window.selectLiveSession?.(s.name, s.agent_type, s.session_id)).catch(() => {}); };

export function openAgentCard(s) {
    const who = resolveSessionIdentity(s);
    const dlg = el('dialog', 'modal-content dlg-form inbox-ask-dialog inbox-card-dialog'); dlg.setAttribute('aria-labelledby', 'inbox-card-title');
    const title = el('h2', null, `${who} asks you`); title.id = 'inbox-card-title'; importOnce('./agent_link.js').then(m => { if (title.isConnected) title.replaceChildren(m.agentLink(who, { board: s.board_project, session: s.session_id }), ' asks you'); }).catch(() => {}); // (#12168)
    const sub = el('p', 'inbox-ask-sub', 'Waiting for a permission. Nothing is sent until you choose.');
    const body = el('div', 'inbox-card-body'); body.setAttribute('aria-live', 'polite');
    const err = el('p', 'inbox-ask-error'); err.setAttribute('role', 'alert');
    const row = el('div', 'inbox-ask-buttons');
    const open = el('button', 'btn', 'Open agent'); open.type = 'button'; open.addEventListener('click', () => { finish(); openAgent(s); });
    const close = el('button', 'btn', 'Close'); close.type = 'button'; close.addEventListener('click', () => finish());
    row.append(open, close);
    dlg.append(title, sub, body, err, row);
    const finish = () => { dlg.close(); dlg.remove(); };
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(); });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg); dlg.showModal(); close.focus();

    const draw = card => {
        body.replaceChildren(); err.textContent = '';
        if (!card) { body.append(el('p', null, 'This card could not be read. It may have been answered. Open the agent to look.')); return; }
        if (card.title) title.textContent = `${who}: ${card.title}`;
        const q = card.title && card.question.startsWith(card.title) ? card.question.slice(card.title.length).trim() : card.question; // the question begins with the title: the heading says it once
        if (q) body.append(Object.assign(el('pre', 'inbox-ask-text', q), { tabIndex: 0 }));
        if (card.target) { const t = el('pre', 'inbox-ask-text', card.target); t.setAttribute('aria-label', 'What it wants to run'); t.tabIndex = 0; body.append(t); }
        if (card.note) body.append(el('p', 'inbox-ask-sub', card.note));
        if (!card.single || !card.options.length) { body.append(el('p', null, 'This one cannot be answered with one choice here. Open the agent to answer it.')); return; }
        if (card.onlyReject) body.append(el('p', 'inbox-only-reject', 'It can only be rejected here: what it wants to run is cut or hidden, or too long to read in full.'));
        const list = el('div', 'inbox-ask-offers-list');
        for (const o of card.options) {
            const b = el('button', 'btn', String(o.label)); b.type = 'button'; b.dataset.n = String(Number(o.n));
            b.addEventListener('click', () => choose(card, o, list));
            list.append(b);
        }
        body.append(list); // the keyboard stays on Close, set at open: a key still going down when the card draws must not answer a permission (the Agents chat card never moves the focus onto an answer either)
    };
    async function choose(card, o, list) {
        const buttons = [...list.querySelectorAll('button')]; buttons.forEach(b => { b.disabled = true; });
        try {
            const now = await readCard(s); // read again at the click: the card may have moved on
            if (!now || now.ask !== card.ask || !now.options.some(p => Number(p.n) === Number(o.n) && p.label === o.label)) { draw(now); err.textContent = 'That question changed. Look at it again.'; return; }
            const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/answer-prompt`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: s.session_id, agent_type: s.agent_type || '', n: Number(o.n), label: o.label, text: '', ask_id: card.ask }),
            });
            if (resp.status === 409) {
                const why = await resp.json().catch(() => ({}));
                if (why.code === 'ask_changed') { draw(await readCard(s)); err.textContent = 'That question changed. Look at it again.'; return; }
                if (why.code === 'answer_sent_prompt_open') { finish(); showToast(`Sent: ${o.label}. Still waiting: check the agent.`); return; }
                throw new Error(why.error || 'HTTP 409');
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            finish();
            showToast(`Answered: ${o.label} for ${who}`, false, 4000);
            document.dispatchEvent(new CustomEvent('coral:inbox-answered', { detail: { session_id: s.session_id, said: `Answered: ${o.label} for ${who}.` } }));
        } catch { buttons.forEach(b => { b.disabled = false; }); err.textContent = 'Could not send the answer from here. Open the agent to answer it there.'; }
    }
    readCard(s).then(draw, () => draw(null));
}
