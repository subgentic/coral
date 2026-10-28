/* Jump to (#10579, the Desktop keyboard pass): Cmd/Ctrl+K opens a box that opens any agent or chat by name, from the keyboard and from anywhere in the page. The agents are the live list's (filtered as it is typed);
 * the chats are the History list's search (a short read per pause in typing, only when there are words). Up and Down move through the matches, Enter opens one, Escape closes the box and the focus goes back where it
 * was (the dialog's own focus handling). The box is a combobox over a listbox: one line says how many matches there are. Names are set as text. */
import { state } from './state.js';
import { ensureBuilt } from './lazy_dom.js';
import { attachDialogFocus } from './dialog_focus.js';
import { historyLabel } from './history_label.js';
import { menuMove } from './menu_keys.js';
import { sessionServer, serverFetch } from './server_base.js';

const MAX_AGENTS = 8, MAX_CHATS = 6, NONE = 'No matches';
let matches = [], current = -1, timer = 0, seq = 0;

const agentLabel = s => s.display_name || s.name || 'Agent';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function agentMatches(words) {
    return (state.liveSessions || []).filter(s => !s.archived && words.every(w => `${agentLabel(s)} ${s.name || ''} ${s.board_project || ''}`.toLowerCase().includes(w)))
        .slice(0, MAX_AGENTS).map(s => ({ label: agentLabel(s), detail: s.board_project ? `Agent in ${s.board_project}` : 'Agent', open: () => window.selectLiveSession(s.name, s.agent_type, s.session_id || '', sessionServer(s), { focusChat: true }) }));
}

function draw(modal, said) {
    const list = modal.querySelector('#jump-list'), input = modal.querySelector('#jump-input');
    list.replaceChildren();
    matches.forEach((m, i) => {
        const li = el('li', 'menu-item jump-option'); li.id = `jump-opt-${i}`; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(i === current));
        li.append(el('span', 'jump-label', m.label), el('span', 'jump-detail', m.detail));
        li.addEventListener('mousedown', e => e.preventDefault()); // the box keeps the focus
        li.addEventListener('click', () => choose(modal, i));
        list.append(li);
    });
    if (current >= 0) input.setAttribute('aria-activedescendant', `jump-opt-${current}`); else input.removeAttribute('aria-activedescendant');
    modal.querySelector('#jump-status').textContent = said;
    list.children[current]?.scrollIntoView({ block: 'nearest' });
}

function choose(modal, i) {
    modal.style.display = 'none'; // display-ok: the same inline state the dialog was opened with
    matches[i]?.open();
}

async function search(modal) {
    const text = modal.querySelector('#jump-input').value.trim().toLowerCase(), mine = ++seq;
    const words = text.split(/\s+/).filter(Boolean);
    matches = agentMatches(words); // no words: every agent of the list
    current = matches.length ? 0 : -1;
    draw(modal, '');
    if (!words.length) return;
    try { // chats: the History list's own search, by words in the title or summary
        const resp = await serverFetch('', `/api/sessions/history?${new URLSearchParams({ q: text, page: '1', page_size: String(MAX_CHATS) })}`);
        if (mine !== seq) return;
        if (!resp.ok) throw new Error('history');
        const data = await resp.json().catch(() => ({}));
        const chats = (data.sessions || []).filter(c => c.session_id).map(c => ({ label: historyLabel(c), detail: 'Chat', open: () => window.selectHistorySession(c.session_id) }));
        if (mine !== seq) return;
        matches = [...matches, ...chats];
        if (current < 0 && matches.length) current = 0;
        draw(modal, matches.length ? `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}` : NONE);
    } catch { if (mine === seq) draw(modal, matches.length ? '' : NONE); }
}

/** Open the box (Cmd/Ctrl+K): empty, with the agents of the list under it. */
export function openJumpTo() {
    const modal = ensureBuilt('jump-modal');
    if (!modal) return;
    if (!modal.dataset.wired) {
        modal.dataset.wired = '1';
        const input = modal.querySelector('#jump-input');
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search(modal), 150); });
        input.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const to = menuMove(e.key, matches.length, current); if (to >= 0) { current = to; draw(modal, ''); } } // the one menu keyboard: Up and Down wrap; Home and End stay the box's caret keys
            else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (current >= 0) choose(modal, current); }
        });
    }
    modal.querySelector('#jump-input').value = '';
    modal.style.display = 'flex'; // display-ok: a dialog is shown as the flex container the .modal rule centres
    attachDialogFocus(modal);
    search(modal);
    modal.querySelector('#jump-input').focus();
}
