/* Answering from the Inbox (#10400, Beta tester #10394): a Needs you row for an agent that asks a question or for a permission carries the card's own choices (Yes, No, Red, Blue ...) as buttons, so a person answers
 * where they found it. The choices are read the way the chat reads them (the chat reply's prompt_options for that agent) and answered through the same route as the chat card (POST .../answer-prompt: the server re-reads the
 * terminal and sends the digit only if the option is still on screen under that label). A question the card cannot answer by one choice (a multi-select, a review step, a text answer, many choices) has no buttons: Open
 * stays for the full card. The labels are the CLI's own words, set as text. */
import { serverFetch, sessionServer } from './server_base.js';
import { showToast } from './utils.js';

const MAX_CHOICES = 4;
const read = new Map(); // server:session:waiting_since -> the choices, read once per ask

async function choicesOf(s) {
    const params = new URLSearchParams({ after: '0', limit: '1', session_id: s.session_id, agent_type: s.agent_type || '' });
    const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/chat?${params}`);
    if (!resp.ok) return [];
    const po = (await resp.json().catch(() => null) || {}).prompt_options;
    if (!po || po.multi || (po.review || []).length) return [];
    const picks = (po.options || []).filter(o => (o.action || 'select') === 'select' && o.label && Number.isInteger(Number(o.n)));
    return picks.length >= 1 && picks.length <= MAX_CHOICES ? picks : [];
}

async function answer(s, o, cell) {
    const buttons = [...cell.querySelectorAll('button')];
    buttons.forEach(b => { b.disabled = true; });
    try {
        const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/answer-prompt`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: s.session_id, agent_type: s.agent_type || '', n: Number(o.n), label: o.label, text: '' }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        read.delete(`${sessionServer(s)}:${s.session_id}:${s.waiting_since || ''}`);
        cell.replaceChildren(Object.assign(document.createElement('span'), { className: 'inbox-answered', textContent: `Answered: ${o.label}` }));
        showToast(`Answered: ${o.label}`, false, 4000, { silent: true });
        document.dispatchEvent(new CustomEvent('coral:inbox-answered', { detail: { session_id: s.session_id } }));
    } catch {
        buttons.forEach(b => { b.disabled = false; });
        showToast('Could not send the answer. Open the agent and use its terminal.', true);
    }
}

/** The Answer cell of a Needs you row: empty for a review or a run, otherwise the choices once they are read. */
export function answerCell(s) {
    if (s.review || s.autorun || !s.agent_type || !s.session_id || s.waiting_kind === 'login') return '';
    const cell = document.createElement('span');
    cell.className = 'inbox-answers';
    const key = `${sessionServer(s)}:${s.session_id}:${s.waiting_since || ''}`;
    if (!read.has(key)) read.set(key, choicesOf(s).catch(() => []));
    read.get(key).then(choices => {
        for (const o of choices) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'btn btn-small inbox-answer'; b.textContent = o.label;
            b.dataset.session = s.session_id; b.dataset.n = String(Number(o.n)); // what finds this choice again after a redraw keeps the keyboard on it (sidebar_groups.js)
            b.setAttribute('aria-label', `Answer ${o.label}`);
            b.addEventListener('click', e => { e.stopPropagation(); answer(s, o, cell); });
            b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
            cell.append(b);
        }
    });
    return cell;
}
